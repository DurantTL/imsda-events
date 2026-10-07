import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { AccessDeniedError, type AuthenticatedUser } from "@/modules/access/authorization";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { directorBackgroundStatesByEmail } from "@/modules/background-checks/repository";
import { directorMatchKey } from "@/modules/background-checks/director-match";
import {
  DECLINE_REASON_MAX,
  MAX_APPLICATION_ATTACHMENT_BYTES,
  NEW_CLUB_INVITE_LIFETIME_DAYS,
  cleanName,
  duplicateMessage,
  newClubSourceOrgType,
  submittedTooQuickly,
  type DirectorBackgroundState,
  type DuplicateFlag,
  type NewClubApplicationInput,
  type NewClubApplicationStatusValue,
  type NewClubDecision,
  type NewClubTypeValue,
} from "@/modules/club-applications/domain";
import { deliverApplicationEmails } from "@/modules/club-applications/deliver";
import { queueDeclinedEmail, queueInviteLinkEmail, queueSubmittedEmail } from "@/modules/club-applications/email";
import { createApplicationDirectorInvite } from "@/modules/club-imports/invites";
import { isAccountEmailConfigured } from "@/modules/communications/account-email";
import {
  ALLOWED_ASSET_TYPES,
  bytesMatchType,
  deleteAsset,
  isAllowedAssetType,
  safeDisplayName,
  writeAsset,
} from "@/modules/events/asset-storage";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { SPONSOR_ORGANIZATION_TYPES, canSponsorClub, normalizeOrganizationName } from "@/modules/organizations/domain";
import { getPlatformSettings } from "@/modules/system-admin/platform-settings";

/**
 * New club applications (#817). The rules, in one place:
 *
 * - Anyone may apply (the public page, or a private invite link), and an
 *   application creates nothing: no club, no invite, no account.
 * - A system administrator approves or declines. Approving creates the club
 *   (an Organization of type CLUB under its sponsoring church) and the
 *   director's ordinary club invite, once, in one transaction: the status
 *   claim (`PENDING` to `APPROVED`) is what makes a double approval impossible.
 * - System administrators and Area Coordinators may read applications and the
 *   attachment; Area Coordinators never decide. Nobody else reads either.
 * - Audit metadata holds ids and flags only. Names, addresses, phones, the
 *   note and the decline reason are never put there.
 */

export type ApplicationViewer = "SYSTEM_ADMIN" | "AREA_COORDINATOR";

export type NewClubApplicationErrorCode =
  | "TOO_QUICK"
  | "INVALID_CHURCH"
  | "CHURCH_REQUIRED"
  | "INVITE_UNAVAILABLE"
  | "ATTACHMENT_TYPE"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_CONTENT"
  | "APPLICATION_NOT_FOUND"
  | "ALREADY_DECIDED"
  | "INVALID_REASON"
  | "EMAIL_NOT_CONFIGURED"
  | "INVITE_NOT_FOUND";

export class NewClubApplicationError extends Error {
  constructor(public readonly code: NewClubApplicationErrorCode, message: string) {
    super(message);
    this.name = "NewClubApplicationError";
  }
}

/** Where attachments live under the private storage root; never a public path, never named by the uploader. */
const ATTACHMENT_PARTITION = "new-club-applications";

function requireViewer(viewer: ApplicationViewer | null | undefined): asserts viewer is ApplicationViewer {
  if (viewer !== "SYSTEM_ADMIN" && viewer !== "AREA_COORDINATOR") {
    throw new AccessDeniedError("Only a system administrator or an Area Coordinator can see new club applications.", 403, "PERMISSION_DENIED");
  }
}

function requireSystemAdmin(actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined): asserts actor is Pick<AuthenticatedUser, "id" | "globalRole"> {
  if (!actor) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
  if (actor.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError("Only a system administrator can approve or decline a new club application.", 403, "PERMISSION_DENIED");
  }
}

// --- Attachment ---------------------------------------------------------

export type CheckedAttachment = {
  type: keyof typeof ALLOWED_ASSET_TYPES;
  bytes: Uint8Array;
  displayName: string;
};

/**
 * The same checks every private upload gets: size first (before reading the
 * bytes), the declared type against a short allow-list (PDF, PNG, JPEG, WebP),
 * then the bytes against that type's signature. A failure writes nothing.
 */
export async function checkApplicationAttachment(file: File): Promise<CheckedAttachment> {
  if (file.size > MAX_APPLICATION_ATTACHMENT_BYTES) {
    throw new NewClubApplicationError("ATTACHMENT_TOO_LARGE", `The attachment must be ${Math.floor(MAX_APPLICATION_ATTACHMENT_BYTES / (1024 * 1024))} MB or smaller.`);
  }
  if (!isAllowedAssetType(file.type)) {
    throw new NewClubApplicationError("ATTACHMENT_TYPE", "Attach a PDF or an image (PNG, JPEG or WebP).");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_APPLICATION_ATTACHMENT_BYTES) {
    throw new NewClubApplicationError("ATTACHMENT_TOO_LARGE", `The attachment must be ${Math.floor(MAX_APPLICATION_ATTACHMENT_BYTES / (1024 * 1024))} MB or smaller.`);
  }
  if (!bytesMatchType(bytes, file.type)) {
    throw new NewClubApplicationError("ATTACHMENT_CONTENT", "That file isn't the kind of file its name says. Attach a PDF or an image.");
  }
  return { type: file.type, bytes, displayName: safeDisplayName(file.name, file.type) };
}

// --- Invites to apply ---------------------------------------------------

function inviteIsOpen(invite: { usedAt: Date | null; cancelledAt: Date | null; expiresAt: Date }, now: Date) {
  return !invite.usedAt && !invite.cancelledAt && invite.expiresAt > now;
}

/** What the invite link's page needs: the address the invite was sent to, to prefill the form. Null for any unusable link. */
export async function resolveNewClubInvite(token: string, now = new Date()) {
  if (!token || token.length > 200) return null;
  const invite = await getPrisma().newClubApplicationInvite.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: { id: true, email: true, name: true, usedAt: true, cancelledAt: true, expiresAt: true },
  });
  if (!invite || !inviteIsOpen(invite, now)) return null;
  return { email: invite.email, name: invite.name };
}

/** A system administrator sends a private "apply for a new club" link to a prospective director. */
export async function createNewClubInvite(
  actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined,
  input: { email: string; name?: string },
  now = new Date(),
) {
  requireSystemAdmin(actor);
  if (!isAccountEmailConfigured()) {
    throw new NewClubApplicationError("EMAIL_NOT_CONFIGURED", "Account email isn't set up on this server, so the link can't be sent yet.");
  }
  const email = input.email.trim().toLowerCase();
  const name = cleanName(input.name ?? "");
  const messageIds = await getPrisma().$transaction(async (tx) => {
    const invite = await tx.newClubApplicationInvite.create({
      data: {
        email,
        name,
        createdByUserId: actor.id,
        expiresAt: new Date(now.getTime() + NEW_CLUB_INVITE_LIFETIME_DAYS * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    const messageId = await queueInviteLinkEmail(tx, { inviteId: invite.id, email, name, days: NEW_CLUB_INVITE_LIFETIME_DAYS });
    if (!messageId) {
      throw new NewClubApplicationError("EMAIL_NOT_CONFIGURED", "Account email isn't set up on this server, so the link can't be sent yet.");
    }
    await tx.newClubApplicationInvite.update({ where: { id: invite.id }, data: { messageId } });
    await writeAuditLog({
      actorUserId: actor.id,
      action: "NEW_CLUB_APPLICATION_INVITE_SENT",
      entityType: "NewClubApplicationInvite",
      entityId: invite.id,
      summary: "Sent a private link to apply for a new club.",
      metadata: { inviteId: invite.id },
    }, tx);
    return [messageId];
  });
  await deliverApplicationEmails(messageIds);
}

export type NewClubInviteRecord = {
  id: string;
  email: string;
  name: string;
  state: "OPEN" | "USED" | "CANCELLED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
};

export async function listNewClubInvites(viewer: ApplicationViewer | null | undefined, now = new Date()): Promise<NewClubInviteRecord[]> {
  if (viewer !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError("Only a system administrator can see the links sent to prospective directors.", 403, "PERMISSION_DENIED");
  }
  const rows = await getPrisma().newClubApplicationInvite.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, email: true, name: true, usedAt: true, cancelledAt: true, expiresAt: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    state: row.usedAt ? "USED" : row.cancelledAt ? "CANCELLED" : row.expiresAt <= now ? "EXPIRED" : "OPEN",
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

/** Withdraws an unused link. */
export async function cancelNewClubInvite(
  actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined,
  inviteId: string,
  now = new Date(),
) {
  requireSystemAdmin(actor);
  await getPrisma().$transaction(async (tx) => {
    const cancelled = await tx.newClubApplicationInvite.updateMany({
      where: { id: inviteId, usedAt: null, cancelledAt: null },
      data: { cancelledAt: now, tokenHash: null },
    });
    if (cancelled.count === 0) throw new NewClubApplicationError("INVITE_NOT_FOUND", "That link was already used or withdrawn.");
    await writeAuditLog({
      actorUserId: actor.id,
      action: "NEW_CLUB_APPLICATION_INVITE_CANCELLED",
      entityType: "NewClubApplicationInvite",
      entityId: inviteId,
      summary: "Withdrew a private link to apply for a new club.",
      metadata: { inviteId },
    }, tx);
  });
}

// --- Submitting ---------------------------------------------------------

/** Every active church, company and group (#822), for the public form's picker: ids, names and kind, nothing else. */
export async function listPublicSponsorOptions() {
  return getPrisma().organization.findMany({
    where: { type: { in: [...SPONSOR_ORGANIZATION_TYPES] }, isActive: true },
    select: { id: true, name: true, type: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function submitNewClubApplication(
  input: NewClubApplicationInput,
  options: { attachment?: File | null; inviteToken?: string | null; now?: Date } = {},
): Promise<{ id: string }> {
  const now = options.now ?? new Date();
  if (submittedTooQuickly(input.formOpenedAt, now)) {
    throw new NewClubApplicationError("TOO_QUICK", "That was sent too quickly. Please check your answers and send it again.");
  }
  const attachment = options.attachment && options.attachment.size > 0 ? await checkApplicationAttachment(options.attachment) : null;
  const prisma = getPrisma();

  let churchName: string | null = null;
  if (input.sponsoringChurchId) {
    const church = await prisma.organization.findFirst({
      where: { id: input.sponsoringChurchId, type: { in: [...SPONSOR_ORGANIZATION_TYPES] }, isActive: true },
      select: { name: true },
    });
    if (!church) throw new NewClubApplicationError("INVALID_CHURCH", "Choose the sponsoring church or company from the list again.");
    churchName = church.name;
  }

  let invite: { id: string; email: string } | null = null;
  if (options.inviteToken) {
    const found = await prisma.newClubApplicationInvite.findUnique({
      where: { tokenHash: hashOpaqueToken(options.inviteToken) },
      select: { id: true, email: true, usedAt: true, cancelledAt: true, expiresAt: true },
    });
    if (!found || !inviteIsOpen(found, now)) {
      throw new NewClubApplicationError("INVITE_UNAVAILABLE", "This link can't be used any more. Ask the conference for a new one, or use the public form.");
    }
    invite = { id: found.id, email: found.email };
  }

  const settings = await getPlatformSettings();
  const clubName = cleanName(input.clubName);
  const directorName = cleanName(input.directorName);
  const stored = attachment ? await writeAsset(ATTACHMENT_PARTITION, attachment.type, attachment.bytes) : null;
  try {
    const { id, messageIds } = await prisma.$transaction(async (tx) => {
      if (invite) {
        // The claim: of two submissions on one link, one wins.
        const claimed = await tx.newClubApplicationInvite.updateMany({
          where: { id: invite.id, usedAt: null, cancelledAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count === 0) {
          throw new NewClubApplicationError("INVITE_UNAVAILABLE", "This link can't be used any more. Ask the conference for a new one, or use the public form.");
        }
      }
      const created = await tx.newClubApplication.create({
        data: {
          source: invite ? "INVITE" : "PUBLIC",
          clubName,
          clubType: input.clubType,
          sponsoringChurchId: input.sponsoringChurchId,
          sponsoringChurchOther: input.sponsoringChurchId ? null : cleanName(input.sponsoringChurchOther ?? ""),
          pastorName: cleanName(input.pastorName),
          directorName,
          directorAddress: input.directorAddress.trim(),
          directorEmail: input.directorEmail,
          directorHomePhone: input.directorHomePhone,
          directorWorkPhone: input.directorWorkPhone,
          philosophyAgreed: true,
          pastorSignature: cleanName(input.pastorSignature),
          headElderSignature: cleanName(input.headElderSignature),
          clerkSignature: cleanName(input.clerkSignature),
          directorSignature: cleanName(input.directorSignature),
          otherBoardMembers: input.otherBoardMembers.map(cleanName),
          applicationDate: new Date(`${calendarDateInEventTimeZone(now, "America/Chicago")}T00:00:00.000Z`),
          note: input.note,
          ...(stored && attachment
            ? {
                attachmentName: attachment.displayName,
                attachmentContentType: attachment.type,
                attachmentByteSize: stored.byteSize,
                attachmentChecksum: stored.checksum,
                attachmentStorageKey: stored.storageKey,
              }
            : {}),
          inviteId: invite?.id ?? null,
          invitedEmail: invite?.email ?? null,
        },
        select: { id: true },
      });
      await writeAuditLog({
        action: "NEW_CLUB_APPLICATION_SUBMITTED",
        entityType: "NewClubApplication",
        entityId: created.id,
        summary: "A new club application was submitted.",
        metadata: {
          applicationId: created.id,
          source: invite ? "INVITE" : "PUBLIC",
          inviteId: invite?.id ?? null,
          sponsoringChurchId: input.sponsoringChurchId,
          hasAttachment: Boolean(stored),
        },
      }, tx);
      const queued = await queueSubmittedEmail(tx, settings.newClubApplicationEmail, {
        applicationId: created.id,
        clubName,
        churchName: churchName ?? cleanName(input.sponsoringChurchOther ?? ""),
        directorName,
      });
      return { id: created.id, messageIds: queued };
    });
    await deliverApplicationEmails(messageIds);
    return { id };
  } catch (error) {
    // Nothing was saved, so the file written for it must not linger.
    if (stored) {
      await deleteAsset(stored.storageKey).catch((cleanupError) => logError("A new club application attachment could not be removed after a failed save.", cleanupError));
    }
    throw error;
  }
}

// --- Reading ------------------------------------------------------------

export type NewClubApplicationRecord = {
  id: string;
  status: NewClubApplicationStatusValue;
  source: "PUBLIC" | "INVITE";
  clubName: string;
  clubType: NewClubTypeValue;
  church: {
    id: string | null;
    name: string;
    isOther: boolean;
    /** A directory church was chosen but it is gone, inactive or no longer a church. */
    unavailable: boolean;
    /** Approving needs the admin to pick a directory church first. */
    needsChoice: boolean;
  };
  pastorName: string;
  director: { name: string; email: string; address: string; homePhone: string | null; workPhone: string | null };
  signatures: { pastor: string; headElder: string; clerk: string; director: string };
  otherBoardMembers: string[];
  applicationDate: string;
  note: string | null;
  attachment: { name: string; contentType: string; byteSize: number } | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  declineReason: string | null;
  createdOrganizationId: string | null;
  sterling: DirectorBackgroundState;
  /** The director's email reached more than one person; the least favorable status is shown. */
  sterlingAmbiguous: boolean;
  /** The person matched by email has a different name than the director typed. */
  sterlingNameMismatch: boolean;
  /** Set for an application from a private link: the address the link was sent to. */
  invitedEmail: string | null;
  invitedEmailDiffers: boolean;
  duplicates: DuplicateFlag[];
};

const recordSelect = {
  id: true,
  status: true,
  source: true,
  clubName: true,
  clubType: true,
  sponsoringChurchId: true,
  sponsoringChurchOther: true,
  pastorName: true,
  directorName: true,
  directorAddress: true,
  directorEmail: true,
  directorHomePhone: true,
  directorWorkPhone: true,
  pastorSignature: true,
  headElderSignature: true,
  clerkSignature: true,
  directorSignature: true,
  otherBoardMembers: true,
  applicationDate: true,
  note: true,
  attachmentName: true,
  attachmentContentType: true,
  attachmentByteSize: true,
  createdAt: true,
  decidedAt: true,
  declineReason: true,
  createdOrganizationId: true,
  invitedEmail: true,
  sponsoringChurch: { select: { name: true, type: true, isActive: true } },
  decidedBy: { select: { displayName: true } },
} satisfies Prisma.NewClubApplicationSelect;

type Row = Prisma.NewClubApplicationGetPayload<{ select: typeof recordSelect }>;

/** Possible duplicates for the waiting applications: same name and church, a church that already has a club, or a twin application. */
async function duplicateFlags(rows: Row[]): Promise<Map<string, DuplicateFlag[]>> {
  const flags = new Map<string, DuplicateFlag[]>();
  const pending = rows.filter((row) => row.status === "PENDING" && row.sponsoringChurchId);
  if (pending.length === 0) return flags;
  const prisma = getPrisma();
  const churchIds = [...new Set(pending.map((row) => row.sponsoringChurchId!))];
  const [clubs, twins] = await Promise.all([
    prisma.organization.findMany({
      where: { type: "CLUB", parentOrganizationId: { in: churchIds } },
      select: { name: true, normalizedName: true, parentOrganizationId: true },
    }),
    prisma.newClubApplication.findMany({
      where: { status: "PENDING", sponsoringChurchId: { in: churchIds } },
      select: { id: true, clubName: true, sponsoringChurchId: true },
    }),
  ]);
  for (const row of pending) {
    const list: DuplicateFlag[] = [];
    const normalized = normalizeOrganizationName(row.clubName);
    const atChurch = clubs.filter((club) => club.parentOrganizationId === row.sponsoringChurchId);
    const same = atChurch.filter((club) => club.normalizedName === normalized);
    if (same.length > 0) {
      list.push({ kind: "SAME_NAME_AND_CHURCH", message: duplicateMessage("SAME_NAME_AND_CHURCH", same[0]!.name) });
    } else if (atChurch.length > 0) {
      list.push({ kind: "CHURCH_HAS_CLUB", message: duplicateMessage("CHURCH_HAS_CLUB", atChurch.map((club) => club.name).join(", ")) });
    }
    const twin = twins.find((other) => other.id !== row.id && other.sponsoringChurchId === row.sponsoringChurchId && normalizeOrganizationName(other.clubName) === normalized);
    if (twin) list.push({ kind: "PENDING_SAME_NAME", message: duplicateMessage("PENDING_SAME_NAME", twin.clubName) });
    if (list.length > 0) flags.set(row.id, list);
  }
  return flags;
}

/** No church to show: a directory sponsor that is gone (the link was cleared), inactive, or not a church, company or group, and nothing typed instead. */
function churchUnavailable(row: Row) {
  if (row.sponsoringChurchId) return !row.sponsoringChurch || !canSponsorClub(row.sponsoringChurch);
  return !row.sponsoringChurchOther;
}

async function toRecords(rows: Row[], now: Date): Promise<NewClubApplicationRecord[]> {
  const [states, duplicates] = await Promise.all([
    directorBackgroundStatesByEmail(rows.map((row) => ({ email: row.directorEmail, name: row.directorName })), now),
    duplicateFlags(rows),
  ]);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    source: row.source,
    clubName: row.clubName,
    clubType: row.clubType,
    church: {
      id: row.sponsoringChurchId,
      name: row.sponsoringChurch?.name ?? row.sponsoringChurchOther ?? "",
      /** The directory sponsor's kind (#822); null for a typed name. */
      type: row.sponsoringChurch?.type ?? null,
      isOther: !row.sponsoringChurchId && Boolean(row.sponsoringChurchOther),
      unavailable: churchUnavailable(row),
      needsChoice: !row.sponsoringChurchId || churchUnavailable(row),
    },
    pastorName: row.pastorName,
    director: {
      name: row.directorName,
      email: row.directorEmail,
      address: row.directorAddress,
      homePhone: row.directorHomePhone,
      workPhone: row.directorWorkPhone,
    },
    signatures: { pastor: row.pastorSignature, headElder: row.headElderSignature, clerk: row.clerkSignature, director: row.directorSignature },
    otherBoardMembers: row.otherBoardMembers,
    applicationDate: row.applicationDate.toISOString().slice(0, 10),
    note: row.note,
    attachment: row.attachmentName && row.attachmentContentType && row.attachmentByteSize !== null
      ? { name: row.attachmentName, contentType: row.attachmentContentType, byteSize: row.attachmentByteSize }
      : null,
    submittedAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByName: row.decidedBy?.displayName ?? null,
    declineReason: row.declineReason,
    createdOrganizationId: row.createdOrganizationId,
    sterling: states.get(directorMatchKey(row.directorEmail, row.directorName))?.state ?? "NO_RECORD",
    sterlingAmbiguous: states.get(directorMatchKey(row.directorEmail, row.directorName))?.ambiguous ?? false,
    sterlingNameMismatch: states.get(directorMatchKey(row.directorEmail, row.directorName))?.nameMismatch ?? false,
    invitedEmail: row.invitedEmail,
    invitedEmailDiffers: Boolean(row.invitedEmail && row.invitedEmail.trim().toLowerCase() !== row.directorEmail),
    duplicates: duplicates.get(row.id) ?? [],
  }));
}

/**
 * The queue: waiting applications first (oldest first), then the most recent
 * decisions. System administrators and Area Coordinators only; the director's
 * contact details and the attachment are in these records, so nobody else may
 * call this.
 */
export async function listNewClubApplications(viewer: ApplicationViewer | null | undefined, now = new Date()) {
  requireViewer(viewer);
  const prisma = getPrisma();
  const [waiting, decided] = await Promise.all([
    prisma.newClubApplication.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 200, select: recordSelect }),
    prisma.newClubApplication.findMany({ where: { status: { not: "PENDING" } }, orderBy: { decidedAt: "desc" }, take: 50, select: recordSelect }),
  ]);
  return toRecords([...waiting, ...decided], now);
}

export async function countWaitingNewClubApplications(viewer: ApplicationViewer | null | undefined) {
  requireViewer(viewer);
  return getPrisma().newClubApplication.count({ where: { status: "PENDING" } });
}

/** The stored attachment's details for the download route; null when there is none. Same viewers as the queue. */
export async function getApplicationAttachment(viewer: ApplicationViewer | null | undefined, applicationId: string) {
  requireViewer(viewer);
  const row = await getPrisma().newClubApplication.findUnique({
    where: { id: applicationId },
    select: { attachmentName: true, attachmentContentType: true, attachmentStorageKey: true },
  });
  if (!row?.attachmentStorageKey || !row.attachmentName || !row.attachmentContentType) return null;
  return { displayName: row.attachmentName, contentType: row.attachmentContentType, storageKey: row.attachmentStorageKey };
}

// --- Deciding -----------------------------------------------------------

/**
 * Approves or declines a waiting application. System administrators only.
 *
 * Approving, in one transaction: claims the application (the conditional
 * update is what stops a second approval), creates the club under its
 * sponsoring church, and makes the director's club invite. The invite is the
 * existing one, so the director signs in, accepts, and lands in the new club.
 * An application whose church was typed as "Other" needs a church chosen from
 * the directory first, because every club has a sponsoring church.
 *
 * Declining emails the applicant, with the reason when one was given.
 */
export async function decideNewClubApplication(
  actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined,
  applicationId: string,
  decision: NewClubDecision,
  now = new Date(),
): Promise<{ status: "APPROVED" | "DECLINED"; organizationId: string | null }> {
  requireSystemAdmin(actor);
  const declineReason = decision.decision === "decline" ? (decision.declineReason?.trim() || null) : null;
  if (declineReason && declineReason.length > DECLINE_REASON_MAX) {
    throw new NewClubApplicationError("INVALID_REASON", `Keep the reason under ${DECLINE_REASON_MAX} characters.`);
  }
  const prisma = getPrisma();

  const result = await prisma.$transaction(async (tx) => {
    const application = await tx.newClubApplication.findUnique({
      where: { id: applicationId },
      select: {
        id: true, status: true, clubName: true, clubType: true, sponsoringChurchId: true,
        directorName: true, directorEmail: true,
      },
    });
    if (!application) throw new NewClubApplicationError("APPLICATION_NOT_FOUND", "That application could not be found.");
    if (application.status !== "PENDING") throw new NewClubApplicationError("ALREADY_DECIDED", "That application was already decided.");

    // Re-checked on every approval: the church may have been removed or deactivated since the applicant chose it.
    let churchId = application.sponsoringChurchId;
    if (decision.decision === "approve" && churchId) {
      const stillThere = await tx.organization.findFirst({ where: { id: churchId, type: { in: [...SPONSOR_ORGANIZATION_TYPES] }, isActive: true }, select: { id: true } });
      if (!stillThere) churchId = null;
    }
    if (decision.decision === "approve" && !churchId) {
      const chosen = decision.sponsoringChurchId;
      if (!chosen) {
        throw new NewClubApplicationError("CHURCH_REQUIRED", "Choose the sponsoring church or company from the directory before approving. The applicant's sponsor isn't in it (typed, removed or no longer active).");
      }
      const church = await tx.organization.findFirst({ where: { id: chosen, type: { in: [...SPONSOR_ORGANIZATION_TYPES] }, isActive: true }, select: { id: true } });
      if (!church) throw new NewClubApplicationError("INVALID_CHURCH", "Choose an active church or company from the directory.");
      churchId = church.id;
    }

    // The claim: of two deciders, one wins; the other gets ALREADY_DECIDED and nothing is created twice.
    const claimed = await tx.newClubApplication.updateMany({
      where: { id: application.id, status: "PENDING" },
      data: {
        status: decision.decision === "approve" ? "APPROVED" : "DECLINED",
        decidedByUserId: actor.id,
        decidedAt: now,
        declineReason,
      },
    });
    if (claimed.count === 0) throw new NewClubApplicationError("ALREADY_DECIDED", "That application was already decided.");

    if (decision.decision === "decline") {
      await writeAuditLog({
        actorUserId: actor.id,
        action: "NEW_CLUB_APPLICATION_DECLINED",
        entityType: "NewClubApplication",
        entityId: application.id,
        summary: "Declined a new club application.",
        metadata: { applicationId: application.id, hasReason: Boolean(declineReason) },
      }, tx);
      const messageIds = await queueDeclinedEmail(tx, {
        applicationId: application.id,
        email: application.directorEmail,
        directorName: application.directorName,
        clubName: application.clubName,
        reason: declineReason,
      });
      return { status: "DECLINED" as const, organizationId: null, messageIds };
    }

    const club = await tx.organization.create({
      data: {
        type: "CLUB",
        name: application.clubName,
        normalizedName: normalizeOrganizationName(application.clubName),
        parentOrganizationId: churchId,
        isActive: true,
        sourceOrgType: newClubSourceOrgType[application.clubType],
      },
      select: { id: true },
    });
    await tx.newClubApplication.update({
      where: { id: application.id },
      data: { createdOrganizationId: club.id, sponsoringChurchId: churchId },
    });
    const invite = await createApplicationDirectorInvite(tx, {
      organizationId: club.id,
      clubName: application.clubName,
      email: application.directorEmail,
      name: application.directorName,
      actorUserId: actor.id,
    }, now);
    await writeAuditLog({
      actorUserId: actor.id,
      action: "ORGANIZATION_CREATED",
      entityType: "Organization",
      entityId: club.id,
      summary: "Created a club from a new club application.",
      metadata: { type: "CLUB", parentOrganizationId: churchId, applicationId: application.id },
    }, tx);
    await writeAuditLog({
      actorUserId: actor.id,
      action: "NEW_CLUB_APPLICATION_APPROVED",
      entityType: "NewClubApplication",
      entityId: application.id,
      summary: "Approved a new club application.",
      metadata: { applicationId: application.id, organizationId: club.id, clubInviteId: invite.inviteId, sponsoringChurchId: churchId },
    }, tx);
    return { status: "APPROVED" as const, organizationId: club.id, messageIds: invite.messageId ? [invite.messageId] : [] };
  });

  await deliverApplicationEmails(result.messageIds);
  return { status: result.status, organizationId: result.organizationId };
}
