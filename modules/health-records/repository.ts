import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { getPrisma } from "@/lib/prisma";
import { isSecretEncryptionConfigured } from "@/lib/secret-box";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import { openHealthField, sealHealthField } from "@/modules/health-records/crypto";
import {
  HEALTH_CONSENT_TEXT,
  HEALTH_CONSENT_VERSION,
  clampHealthLinkDays,
  healthWindowOpen,
  viewerCanSeeEvent,
  viewerNeedsEvent,
  fieldValuesFromInput,
  hasHealthNoteFor,
  healthAuditActor,
  healthFieldsNeedingCorrection,
  healthRecordInputSchemaFor,
  healthRecordStatus,
  isHealthFieldKey,
  viewerActorId,
  viewerCan,
  type HealthAction,
  type HealthRecordInput,
  type HealthRecordStatus,
  type HealthViewer,
} from "@/modules/health-records/domain";
import { HEALTH_LINK_UNAVAILABLE_MESSAGE, HEALTH_MEMBER_NOT_FOUND_MESSAGE, HealthRecordError } from "@/modules/health-records/errors";
import { healthRecordsEnabled, requireHealthRecordsEnabled } from "@/modules/health-records/flag";
import { HEALTH_RECORD_LINK_TEMPLATE_KEY, healthRecordLinkEmailContent } from "@/modules/health-records/link-email";

/**
 * Pathfinder Health Record storage and use (#611). Every entry point checks
 * the feature flag first, then the viewer, then writes its audit row, and only
 * then opens (or seals) any health value. Audit rows hold ids, counts and
 * years: never a health value, an address, a phone number or an email.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type Client = Prisma.TransactionClient;

function unavailable() {
  return new HealthRecordError("LINK_UNAVAILABLE", HEALTH_LINK_UNAVAILABLE_MESSAGE);
}

function allow(viewer: HealthViewer, organizationId: string, action: HealthAction) {
  if (!viewerCan(viewer, organizationId, action)) {
    // Another club's record is not found; a permitted viewer without this action is forbidden.
    if (viewer.kind === "CLUB_LEADER") throw new HealthRecordError("MEMBER_NOT_FOUND", HEALTH_MEMBER_NOT_FOUND_MESSAGE);
    throw new HealthRecordError("FORBIDDEN", "Your access to health records is view-only.");
  }
}

/** Turns a validation failure into field messages only, so no submitted value is ever echoed. */
export function parseHealthRecordInput(raw: unknown, stored: Record<string, unknown> = {}): HealthRecordInput {
  try {
    return healthRecordInputSchemaFor(stored).parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({ field: String(issue.path[0] ?? ""), message: issue.message }));
      throw new HealthRecordError("VALIDATION_FAILED", issues[0]?.message ?? "Check the form and try again.", issues);
    }
    throw error;
  }
}

async function loadMember(
  client: Pick<Client, "clubRosterMember">,
  organizationId: string,
  memberId: string,
  now: Date,
  // An Area Coordinator's event-scoped view may reach a member whose roster row
  // is from the club year just ended (the window runs 30 days past the event).
  options: { anyYear?: boolean } = {},
) {
  const member = await client.clubRosterMember.findFirst({
    where: { id: memberId, organizationId, status: "ACTIVE", ...(options.anyYear ? {} : { clubYear: clubYearFor(now) }) },
    select: {
      id: true,
      personId: true,
      organization: { select: { name: true, isActive: true, type: true, parentOrganization: { select: { name: true } } } },
      person: { select: { firstName: true, lastName: true } },
    },
  });
  if (!member || member.organization.type !== "CLUB" || !member.organization.isActive) {
    throw new HealthRecordError("MEMBER_NOT_FOUND", HEALTH_MEMBER_NOT_FOUND_MESSAGE);
  }
  return member;
}

type LoadedMember = Awaited<ReturnType<typeof loadMember>>;

/**
 * An Area Coordinator, or staff with the health role, may open a record only
 * for a member who is an attendee of a submitted or confirmed registration by
 * this club for this event, and only while the event's window is open
 * (`healthWindowOpen`). Every miss, whatever the reason, is the same "not found".
 */
async function assertEventScope(
  client: Pick<Client, "clubEventRegistration">,
  input: { viewer: HealthViewer; eventId: string | undefined; organizationId: string; member: Pick<LoadedMember, "personId">; now: Date },
) {
  const notFound = () => new HealthRecordError("MEMBER_NOT_FOUND", HEALTH_MEMBER_NOT_FOUND_MESSAGE);
  if (!input.eventId || !input.member.personId || !viewerCanSeeEvent(input.viewer, input.eventId)) throw notFound();
  const registration = await client.clubEventRegistration.findFirst({
    where: {
      eventId: input.eventId,
      organizationId: input.organizationId,
      registration: {
        status: { in: ["SUBMITTED", "CONFIRMED"] },
        attendees: { some: { personId: input.member.personId } },
      },
    },
    select: { event: { select: { timezone: true, endsAt: true, isPublished: true } } },
  });
  // The event model has no cancelled or archived state, and a deleted event takes
  // its registrations with it; an unpublished event is the one "not open" state.
  if (!registration || !registration.event.isPublished || !healthWindowOpen(registration.event, input.now)) throw notFound();
}

/**
 * The member's record: by this roster row, or else the same person's record
 * from an earlier club year (rows are per year), which then reads as
 * "Needs update" until it is saved or confirmed again.
 */
async function findRecord(client: Pick<Client, "healthRecord">, organizationId: string, member: Pick<LoadedMember, "id" | "personId">) {
  const select = { id: true, confirmedClubYear: true, hasHealthNote: true, lastEnteredVia: true, fields: { select: { fieldKey: true, sealedValue: true } } } as const;
  const own = await client.healthRecord.findUnique({ where: { rosterMemberId: member.id }, select });
  if (own) return own;
  if (!member.personId) return null;
  return client.healthRecord.findFirst({
    where: { organizationId, rosterMember: { personId: member.personId } },
    orderBy: { updatedAt: "desc" },
    select,
  });
}

function openFields(recordId: string, fields: Array<{ fieldKey: string; sealedValue: string }>) {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (isHealthFieldKey(field.fieldKey)) values[field.fieldKey] = openHealthField(recordId, field.fieldKey, field.sealedValue);
  }
  return values;
}

export type HealthTabView = {
  member: { id: string; firstName: string; lastName: string };
  club: { name: string; sponsoringChurch: string | null };
  status: HealthRecordStatus;
  hasHealthNote: boolean;
  /** Opened values, keyed by field. Empty when no record exists. */
  values: Record<string, unknown>;
  /** Stored fields that fail today's checks (#855), by key, so the form can ask for a correction. Never a value. */
  needsCorrection: string[];
  canEdit: boolean;
  consentText: typeof HEALTH_CONSENT_TEXT;
  consentVersion: string;
};

/** Opens the Health tab. The audit row is written before any value is decrypted. */
export async function viewHealthRecord(
  viewer: HealthViewer,
  organizationId: string,
  memberId: string,
  now = new Date(),
  options: { eventId?: string } = {},
): Promise<HealthTabView> {
  requireHealthRecordsEnabled();
  allow(viewer, organizationId, "VIEW");
  const prisma = getPrisma();
  const scoped = viewerNeedsEvent(viewer);
  const member = await loadMember(prisma, organizationId, memberId, now, { anyYear: scoped });
  if (scoped) await assertEventScope(prisma, { viewer, eventId: options.eventId, organizationId, member, now });
  const record = await findRecord(prisma, organizationId, member);
  const who = healthAuditActor(viewer);
  await writeAuditLog({
    // No top-level eventId: that column feeds the event staff audit log, which must not list these views. The event is in the metadata.
    actorUserId: who.actorUserId,
    action: "HEALTH_RECORD_VIEWED",
    entityType: "HealthRecord",
    entityId: record?.id ?? memberId,
    summary: "Opened a member's health record.",
    metadata: {
      ...who.metadata,
      organizationId,
      rosterMemberId: memberId,
      recordExists: record !== null,
      // The event a coordinator or health-role viewer opened it through (null for everyone else).
      eventId: scoped ? options.eventId ?? null : null,
    },
  });
  const values = record ? openFields(record.id, record.fields) : {};
  return {
    member: { id: member.id, firstName: member.person?.firstName ?? "", lastName: member.person?.lastName ?? "" },
    club: { name: member.organization.name, sponsoringChurch: member.organization.parentOrganization?.name ?? null },
    status: healthRecordStatus(record, now),
    hasHealthNote: record?.hasHealthNote ?? false,
    values,
    needsCorrection: healthFieldsNeedingCorrection(values),
    canEdit: viewerCan(viewer, organizationId, "EDIT"),
    consentText: HEALTH_CONSENT_TEXT,
    consentVersion: HEALTH_CONSENT_VERSION,
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Two first saves for the same person can both try to create the record; the
 * loser hits the unique key. Retry once (the record now exists, so it updates),
 * then answer a friendly conflict rather than an error.
 */
async function withFirstSaveRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) throw new HealthRecordError("CONFLICT", "This record was just saved by someone else. Please reload and try again.");
    throw error;
  }
}

function requireEncryption() {
  if (!isSecretEncryptionConfigured()) {
    throw new HealthRecordError("ENCRYPTION_NOT_CONFIGURED", "Health records can't be saved right now. Please try again later.");
  }
}

/** Replaces the member's whole record with the submitted fields, each sealed on its own. */
async function writeRecord(
  tx: Client,
  input: {
    organizationId: string;
    member: Pick<LoadedMember, "id" | "personId">;
    input: HealthRecordInput;
    via: "DIRECTOR" | "LINK";
    savedBy: string | null;
    now: Date;
  },
) {
  const existing = await findRecord(tx, input.organizationId, input.member);
  const recordId = existing?.id ?? randomUUID();
  const values = fieldValuesFromInput(input.input, input.now);
  const rows = Object.entries(values).map(([fieldKey, value]) => ({ fieldKey, sealedValue: sealHealthField(recordId, fieldKey, value) }));
  const common = {
    confirmedClubYear: clubYearFor(input.now),
    hasHealthNote: hasHealthNoteFor(values),
    lastEnteredVia: input.via,
    lastSavedByActor: input.savedBy,
  };
  if (existing) {
    await tx.healthRecord.update({ where: { id: recordId }, data: { ...common, rosterMemberId: input.member.id } });
    await tx.healthRecordField.deleteMany({ where: { recordId } });
    await tx.healthRecordField.createMany({ data: rows.map((row) => ({ recordId, ...row })) });
  } else {
    await tx.healthRecord.create({
      data: {
        id: recordId,
        organizationId: input.organizationId,
        rosterMemberId: input.member.id,
        ...common,
        fields: { create: rows },
      },
    });
  }
  return { recordId, fieldCount: rows.length, hasHealthNote: common.hasHealthNote, created: !existing };
}

/** The member's stored values, opened for comparison only. Null when there is no record or it cannot be opened. */
async function storedValuesForMember(organizationId: string, memberId: string, now: Date): Promise<Record<string, unknown> | null> {
  try {
    const prisma = getPrisma();
    const member = await loadMember(prisma, organizationId, memberId, now);
    const record = await findRecord(prisma, organizationId, member);
    return record ? openFields(record.id, record.fields) : null;
  } catch {
    return null;
  }
}

/** A director or deputy types the record in from the paper form (or corrects it). */
export async function saveHealthRecord(viewer: HealthViewer, organizationId: string, memberId: string, rawInput: unknown, now = new Date()) {
  requireHealthRecordsEnabled();
  allow(viewer, organizationId, "EDIT");
  let input: HealthRecordInput;
  try {
    input = parseHealthRecordInput(rawInput);
  } catch (error) {
    if (!(error instanceof HealthRecordError) || error.code !== "VALIDATION_FAILED") throw error;
    // Editing (#855): an old answer that fails today's checks and was not changed does not block the save. The
    // stored values are opened only to compare; no message or log carries one.
    const stored = await storedValuesForMember(organizationId, memberId, now);
    if (!stored) throw error;
    input = parseHealthRecordInput(rawInput, stored);
  }
  requireEncryption();
  const who = healthAuditActor(viewer);
  return withFirstSaveRetry(() => getPrisma().$transaction(async (tx) => {
    const member = await loadMember(tx, organizationId, memberId, now);
    const written = await writeRecord(tx, { organizationId, member, input, via: "DIRECTOR", savedBy: viewerActorId(viewer), now });
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: written.created ? "HEALTH_RECORD_CREATED" : "HEALTH_RECORD_UPDATED",
      entityType: "HealthRecord",
      entityId: written.recordId,
      summary: written.created ? "Created a member's health record." : "Updated a member's health record.",
      metadata: { ...who.metadata, organizationId, rosterMemberId: memberId, fieldCount: written.fieldCount, clubYear: clubYearFor(now) },
    }, tx);
    return { recordId: written.recordId, status: "CURRENT" as const };
  }));
}

/** The director confirms last year's record is still right for this club year. */
export async function confirmHealthRecord(viewer: HealthViewer, organizationId: string, memberId: string, now = new Date()) {
  requireHealthRecordsEnabled();
  allow(viewer, organizationId, "EDIT");
  const who = healthAuditActor(viewer);
  return getPrisma().$transaction(async (tx) => {
    const member = await loadMember(tx, organizationId, memberId, now);
    const record = await findRecord(tx, organizationId, member);
    if (!record) throw new HealthRecordError("MEMBER_NOT_FOUND", "There is no health record to confirm yet.");
    await tx.healthRecord.update({
      where: { id: record.id },
      data: { confirmedClubYear: clubYearFor(now), rosterMemberId: member.id, lastSavedByActor: viewerActorId(viewer) },
    });
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: "HEALTH_RECORD_CONFIRMED",
      entityType: "HealthRecord",
      entityId: record.id,
      summary: "Confirmed a member's health record for the club year.",
      metadata: { ...who.metadata, organizationId, rosterMemberId: memberId, clubYear: clubYearFor(now) },
    }, tx);
    return { recordId: record.id, status: "CURRENT" as const };
  });
}

export type HealthSummary = { status: HealthRecordStatus; hasHealthNote: boolean };

/**
 * Status and the plain "has a health note" flag for a club's members. No
 * health text and no decryption, so it is not a view of the record and is
 * not audited; it still requires a permitted viewer.
 */
export async function healthSummariesForMembers(
  viewer: HealthViewer,
  organizationId: string,
  memberIds: string[],
  now = new Date(),
): Promise<Record<string, HealthSummary>> {
  requireHealthRecordsEnabled();
  allow(viewer, organizationId, "VIEW");
  // Event-scoped viewers have no roster-wide view; only the event-scoped record.
  if (viewerNeedsEvent(viewer)) throw new HealthRecordError("FORBIDDEN", "Health summaries are for the club's own leaders and system administrators.");
  if (memberIds.length === 0) return {};
  const records = await getPrisma().healthRecord.findMany({
    where: { organizationId, rosterMemberId: { in: memberIds } },
    select: { rosterMemberId: true, confirmedClubYear: true, hasHealthNote: true },
  });
  const byMember = new Map(records.map((record) => [record.rosterMemberId, record]));
  return Object.fromEntries(memberIds.map((id) => {
    const record = byMember.get(id) ?? null;
    return [id, { status: healthRecordStatus(record, now), hasHealthNote: record?.hasHealthNote ?? false }];
  }));
}

/**
 * The plain "a health record exists" marker for a club's roster rows (#611),
 * for any viewer who can already see those rows, including one with no health
 * access. One boolean per member and nothing else: not whether it holds a
 * clinical note, no status, no text, no decryption. A record is found by
 * person within the club, so one still attached to an earlier year's row
 * counts. The caller must already hold roster access for `organizationId`;
 * with the feature off it returns nothing.
 */
export async function healthRecordFlagsForRoster(organizationId: string, memberIds: string[]): Promise<Record<string, boolean>> {
  if (!healthRecordsEnabled() || memberIds.length === 0) return {};
  const prisma = getPrisma();
  const members = await prisma.clubRosterMember.findMany({
    where: { id: { in: memberIds }, organizationId },
    select: { id: true, personId: true },
  });
  const personIds = members.flatMap((member) => (member.personId ? [member.personId] : []));
  const records = await prisma.healthRecord.findMany({
    where: {
      organizationId,
      OR: [{ rosterMemberId: { in: memberIds } }, ...(personIds.length > 0 ? [{ rosterMember: { personId: { in: personIds } } }] : [])],
    },
    select: { rosterMemberId: true, rosterMember: { select: { personId: true } } },
  });
  const rowsWithRecord = new Set(records.map((record) => record.rosterMemberId));
  const peopleWithRecord = new Set(records.flatMap((record) => (record.rosterMember.personId ? [record.rosterMember.personId] : [])));
  return Object.fromEntries(
    members
      .filter((member) => rowsWithRecord.has(member.id) || (member.personId !== null && peopleWithRecord.has(member.personId)))
      .map((member) => [member.id, true]),
  );
}

// ---------------------------------------------------------------------------
// Parent private links. Same shape as club form links (#610): only the hash
// of the token is stored, the token is minted when the email is delivered,
// and a link works once.

export type CreateHealthLinkInput = {
  organizationId: string;
  rosterMemberId: string;
  recipientEmail: string;
  expiresInDays?: number;
};

export async function createHealthRecordLink(viewer: HealthViewer, input: CreateHealthLinkInput, now = new Date()) {
  requireHealthRecordsEnabled();
  allow(viewer, input.organizationId, "SEND_LINK");
  if (viewer.kind !== "CLUB_LEADER") throw new HealthRecordError("FORBIDDEN", "Only the club's director or deputy can send a link.");
  if (!isAccountEmailConfigured()) {
    throw new HealthRecordError("EMAIL_NOT_CONFIGURED", "Email isn't set up on this server, so a link can't be sent yet.");
  }
  const prisma = getPrisma();
  const member = await loadMember(prisma, input.organizationId, input.rosterMemberId, now);
  const days = clampHealthLinkDays(input.expiresInDays);
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  const sender = getAccountEmailSender();
  const content = healthRecordLinkEmailContent({
    clubName: member.organization.name,
    days,
    expiresOn: expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }),
  });
  const who = healthAuditActor(viewer);

  return prisma.$transaction(async (tx) => {
    // One live link per member: a new one withdraws any earlier open link.
    await tx.healthRecordLink.updateMany({
      where: { rosterMemberId: input.rosterMemberId, status: "OPEN" },
      data: { status: "REVOKED", revokedAt: now, tokenHash: null },
    });
    const link = await tx.healthRecordLink.create({
      data: {
        organizationId: input.organizationId,
        rosterMemberId: input.rosterMemberId,
        clubYear: clubYearFor(now),
        recipientEmail,
        expiresAt,
        createdByActor: viewerActorId(viewer),
      },
      select: { id: true },
    });
    const message = await tx.messageOutbox.create({
      data: {
        eventId: null,
        templateKey: HEALTH_RECORD_LINK_TEMPLATE_KEY,
        recipientKind: "ACCOUNT",
        recipientEmail,
        recipientName: null,
        senderNameSnapshot: sender.name,
        senderEmailSnapshot: sender.address,
        replyToEmailSnapshot: sender.replyTo,
        subjectSnapshot: content.subject,
        bodyTextSnapshot: content.bodyText,
        metadata: { trigger: "HEALTH_RECORD_LINK", accountEmail: true, realDelivery: true, healthRecordLinkId: link.id },
        idempotencyKey: `health-record-link:${link.id}`,
        correlationId: randomUUID(),
        status: "PENDING",
      },
      select: { id: true },
    });
    await tx.healthRecordLink.update({ where: { id: link.id }, data: { messageId: message.id } });
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: "HEALTH_RECORD_LINK_CREATED",
      entityType: "HealthRecordLink",
      entityId: link.id,
      summary: "Sent a private link to fill in a health record.",
      // No address, no token: who sent it, for which member, and when it expires.
      metadata: { ...who.metadata, organizationId: input.organizationId, rosterMemberId: input.rosterMemberId, expiresAt: expiresAt.toISOString() },
    }, tx);
    return { linkId: link.id, messageId: message.id, expiresAt };
  });
}

export type HealthLinkState = "OPEN" | "USED" | "REVOKED" | "EXPIRED";

export function healthLinkState(link: { status: string; expiresAt: Date }, now: Date): HealthLinkState {
  if (link.status === "USED") return "USED";
  if (link.status === "REVOKED") return "REVOKED";
  return link.expiresAt <= now ? "EXPIRED" : "OPEN";
}

/** A member's recent links: never a token. */
export async function listHealthRecordLinks(viewer: HealthViewer, organizationId: string, memberId: string, now = new Date()) {
  requireHealthRecordsEnabled();
  allow(viewer, organizationId, "SEND_LINK");
  if (viewer.kind !== "CLUB_LEADER") throw new HealthRecordError("FORBIDDEN", "Only the club's director or deputy can see links.");
  const links = await getPrisma().healthRecordLink.findMany({
    where: { organizationId, rosterMemberId: memberId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, recipientEmail: true, status: true, expiresAt: true, usedAt: true, createdAt: true },
  });
  return links.map((link) => ({
    id: link.id,
    recipientEmail: link.recipientEmail,
    state: healthLinkState(link, now),
    expiresAt: link.expiresAt.toISOString(),
    usedAt: link.usedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  }));
}

export async function revokeHealthRecordLink(viewer: HealthViewer, organizationId: string, linkId: string, now = new Date()) {
  requireHealthRecordsEnabled();
  allow(viewer, organizationId, "SEND_LINK");
  if (viewer.kind !== "CLUB_LEADER") throw new HealthRecordError("FORBIDDEN", "Only the club's director or deputy can withdraw a link.");
  const who = healthAuditActor(viewer);
  return getPrisma().$transaction(async (tx) => {
    const link = await tx.healthRecordLink.findFirst({ where: { id: linkId, organizationId }, select: { id: true } });
    if (!link) throw new HealthRecordError("LINK_NOT_FOUND", "That link could not be found.");
    const revoked = await tx.healthRecordLink.updateMany({
      where: { id: link.id, status: "OPEN" },
      data: { status: "REVOKED", revokedAt: now, tokenHash: null },
    });
    if (revoked.count === 0) throw new HealthRecordError("LINK_UNAVAILABLE", "That link was already used or withdrawn.");
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: "HEALTH_RECORD_LINK_REVOKED",
      entityType: "HealthRecordLink",
      entityId: link.id,
      summary: "Withdrew a private link to a health record.",
      metadata: { ...who.metadata, organizationId },
    }, tx);
  });
}

// ---------------------------------------------------------------------------
// The public side: no account, only the token.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

async function findUsableLink(token: string, now: Date) {
  requireHealthRecordsEnabled();
  if (!TOKEN_PATTERN.test(token)) throw unavailable();
  const link = await getPrisma().healthRecordLink.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      organizationId: true,
      rosterMemberId: true,
      rosterMember: {
        select: {
          id: true,
          personId: true,
          status: true,
          clubYear: true,
          person: { select: { firstName: true } },
          organization: { select: { name: true, isActive: true, type: true } },
        },
      },
    },
  });
  if (
    !link
    || link.status !== "OPEN"
    || link.expiresAt <= now
    || link.rosterMember.status !== "ACTIVE"
    || !link.rosterMember.organization.isActive
    || link.rosterMember.organization.type !== "CLUB"
  ) {
    throw unavailable();
  }
  // The link names a roster row, but rows are per club year. A link for an older
  // year must write to the person's current-year row, never move the record back
  // onto the old one; with no current-year row it is as good as unusable.
  let member: { id: string; personId: string | null; firstName: string } = {
    id: link.rosterMember.id,
    personId: link.rosterMember.personId,
    firstName: link.rosterMember.person?.firstName ?? "",
  };
  if (link.rosterMember.clubYear !== clubYearFor(now)) {
    if (!link.rosterMember.personId) throw unavailable();
    const current = await getPrisma().clubRosterMember.findFirst({
      where: { organizationId: link.organizationId, personId: link.rosterMember.personId, clubYear: clubYearFor(now), status: "ACTIVE" },
      select: { id: true, personId: true, person: { select: { firstName: true } } },
    });
    if (!current) throw unavailable();
    member = { id: current.id, personId: current.personId, firstName: current.person?.firstName ?? "" };
  }
  return { ...link, member };
}

/** What the link's page shows: the club, the member's first name, and the empty form. Never any stored value. */
export async function resolveHealthLinkForFill(token: string, now = new Date()) {
  const link = await findUsableLink(token, now);
  return {
    clubName: link.rosterMember.organization.name,
    memberFirstName: link.member.firstName,
    consentText: HEALTH_CONSENT_TEXT,
    consentVersion: HEALTH_CONSENT_VERSION,
  };
}

/**
 * Submits the record behind a link, exactly once. The link is spent by a
 * guarded update inside the same transaction that writes the record, so two
 * requests racing with the same link cannot both succeed.
 */
export async function submitHealthRecordViaLink(token: string, rawInput: unknown, now = new Date()) {
  const link = await findUsableLink(token, now);
  const input = parseHealthRecordInput(rawInput);
  requireEncryption();
  const tokenHash = hashOpaqueToken(token);
  return withFirstSaveRetry(() => getPrisma().$transaction(async (tx) => {
    const spent = await tx.healthRecordLink.updateMany({
      where: { id: link.id, tokenHash, status: "OPEN", expiresAt: { gt: now } },
      data: { status: "USED", usedAt: now, tokenHash: null },
    });
    if (spent.count === 0) throw unavailable();
    const written = await writeRecord(tx, {
      organizationId: link.organizationId,
      member: { id: link.member.id, personId: link.member.personId },
      input,
      via: "LINK",
      savedBy: null,
      now,
    });
    await writeAuditLog({
      action: "HEALTH_RECORD_LINK_SUBMITTED",
      entityType: "HealthRecord",
      entityId: written.recordId,
      summary: "A health record was submitted through a private link.",
      metadata: { organizationId: link.organizationId, rosterMemberId: link.member.id, linkId: link.id, fieldCount: written.fieldCount, clubYear: clubYearFor(now) },
    }, tx);
    return { recordId: written.recordId };
  }));
}
