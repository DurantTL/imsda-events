import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import {
  clubAssignableRoles,
  clubDirectorRoleLabels,
  clubRoleIsAssignableByClub,
  type ClubRole,
} from "@/modules/organizations/director-grants-domain";

/** How long a SENT invite may still be accepted (#425). */
export const CLUB_INVITE_LIFETIME_DAYS = 14;
/** How soon after a send the same invite may be resent (#425): keeps a director from spamming one inbox. */
export const CLUB_INVITE_RESEND_COOLDOWN_MINUTES = 5;

export function clubInviteExpiry(now: Date) {
  return new Date(now.getTime() + CLUB_INVITE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Conference invites for club directors and deputies (#376). An invite is
 * created PENDING by the import and emailed only when an administrator
 * presses Send (bulk email is a human step). The email carries no secret:
 * a SENT invite is accepted from the account page, and only by a signed-in
 * account whose verified email is the invite's address. Accepting creates
 * the ordinary director grant (#354), so every club screen works unchanged.
 */

export type ClubInviteErrorCode =
  | "INVITE_NOT_FOUND"
  | "INVITE_NOT_OPEN"
  | "INVITE_EMAIL_MISMATCH"
  | "INVITE_EXPIRED"
  | "INVITE_ALREADY_OPEN"
  | "INVITE_ROLE_NOT_ALLOWED"
  | "INVITE_RESEND_TOO_SOON"
  | "EMAIL_NOT_CONFIGURED"
  | "NOTHING_TO_SEND";

export class ClubInviteError extends Error {
  constructor(public readonly code: ClubInviteErrorCode, message: string) {
    super(message);
    this.name = "ClubInviteError";
  }
}

export async function listClubInvites() {
  const invites = await getPrisma().clubInvite.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: [{ organization: { name: "asc" } }, { role: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      sentAt: true,
      sentCount: true,
      acceptedAt: true,
      organization: { select: { id: true, name: true, isActive: true } },
    },
  });
  return invites.map((invite) => ({
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    status: invite.status,
    sentAt: invite.sentAt?.toISOString() ?? null,
    sentCount: invite.sentCount,
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    club: invite.organization,
  }));
}

export type ClubInviteRecord = Awaited<ReturnType<typeof listClubInvites>>[number];

/**
 * Where a club invite's email sends someone to act on it: the sign-up page,
 * with the invited address prefilled the same way a Google sign-up return
 * prefills it (`sign-up-prefill.ts`). Someone who already has an account
 * should sign in instead; the email says so and gives that link too.
 * There is no token in this link: acceptance is decided by the signed-in
 * account's own verified email matching the invite, not by anything the link
 * carries, so nothing here is a secret to protect.
 */
export function clubInviteSignUpUrl(email: string) {
  const url = new URL("/account/sign-up", getServerEnv().APP_BASE_URL);
  url.hash = `email=${encodeURIComponent(email.trim().toLowerCase())}`;
  return url.toString();
}

function inviteEmail(input: {
  name: string;
  email: string;
  clubName: string;
  role: "DIRECTOR" | "DEPUTY" | "REGISTRAR" | "REPORTER";
  source: "IMPORT" | "CLUB";
}) {
  const signUpUrl = clubInviteSignUpUrl(input.email);
  const role = clubDirectorRoleLabels[input.role].toLocaleLowerCase("en-US");
  const invitedBy = input.source === "CLUB"
    ? `${input.clubName}'s director or deputy has invited you as the club's ${role} on IMSDA Events.`
    : `The Iowa-Missouri Conference has set up ${input.clubName} on IMSDA Events and invited you as the club's ${role}.`;
  const context = input.source === "CLUB"
    ? "Once you accept, you'll see this club under My club when you sign in."
    : "Your club's roster from this year's registration is already there. Please add each person's birth date as you go; until then they're marked \"birth date needed\".";
  // Only club-created invites (#425) expire; a staff import invite (reusing this flow, #376) never did.
  const expiryLine = input.source === "CLUB" ? [`This invite expires in ${CLUB_INVITE_LIFETIME_DAYS} days.`, ""] : [];
  return {
    subject: `You're invited to help run ${input.clubName} on IMSDA Events`,
    bodyText: [
      `Hello ${input.name.trim() || "there"},`,
      "",
      invitedBy,
      "",
      "To accept:",
      `1. New to IMSDA Events? Create your account at ${signUpUrl}`,
      `   Already have one? Sign in at ${new URL("/account/sign-in", getServerEnv().APP_BASE_URL).toString()}`,
      `2. Use this email address: ${input.email}`,
      "3. On your account page, choose Accept next to the club invite.",
      "",
      context,
      "",
      ...expiryLine,
      "If you weren't expecting this, you can ignore it. Nothing happens unless you accept.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

/**
 * Emails invites and marks them SENT. `organizationId` sends a club's PENDING
 * invites; `inviteIds` sends (or resends) exactly those; neither sends every
 * PENDING invite. Returns the queued message ids for delivery.
 */
export async function sendClubInvites(
  selection: { organizationId?: string; inviteIds?: string[] },
  actorUserId: string,
  now = new Date(),
) {
  if (!isAccountEmailConfigured()) {
    throw new ClubInviteError("EMAIL_NOT_CONFIGURED", "Account email isn't set up on this server, so invites can't be sent yet.");
  }
  const sender = getAccountEmailSender();
  const prisma = getPrisma();
  const where: Prisma.ClubInviteWhereInput = selection.inviteIds
    ? { id: { in: selection.inviteIds }, status: { in: ["PENDING", "SENT"] } }
    : { status: "PENDING", ...(selection.organizationId ? { organizationId: selection.organizationId } : {}) };
  const invites = await prisma.clubInvite.findMany({
    where: { ...where, organization: { isActive: true } },
    select: { id: true, email: true, name: true, role: true, source: true, organizationId: true, organization: { select: { name: true } } },
  });
  if (invites.length === 0) throw new ClubInviteError("NOTHING_TO_SEND", "There are no invites waiting to be sent.");

  const correlationId = randomUUID();
  const messageIds: string[] = [];
  for (const invite of invites) {
    const content = inviteEmail({
      name: invite.name,
      email: invite.email,
      clubName: invite.organization.name,
      role: invite.role,
      source: invite.source === "CLUB" ? "CLUB" : "IMPORT",
    });
    const messageId = await prisma.$transaction(async (tx) => {
      const message = await tx.messageOutbox.create({
        data: {
          eventId: null,
          templateKey: "CLUB_INVITE",
          recipientKind: "ACCOUNT",
          recipientEmail: invite.email,
          recipientName: invite.name || null,
          senderNameSnapshot: sender.name,
          senderEmailSnapshot: sender.address,
          replyToEmailSnapshot: sender.replyTo,
          subjectSnapshot: content.subject,
          bodyTextSnapshot: content.bodyText,
          metadata: { trigger: "CLUB_INVITE_SENT", accountEmail: true, realDelivery: true, clubInviteId: invite.id },
          idempotencyKey: `club-invite:${invite.id}:${randomUUID()}`,
          correlationId,
          status: "PENDING",
        },
        select: { id: true },
      });
      // Staff import invites (#376) reuse this flow's model and email but keep their prior, unexpiring behavior;
      // only club-created invites (#425) get the 14-day expiry.
      const expiresAt = invite.source === "CLUB" ? clubInviteExpiry(now) : null;
      await tx.clubInvite.update({
        where: { id: invite.id },
        data: { status: "SENT", sentAt: now, sentCount: { increment: 1 }, lastMessageId: message.id, expiresAt },
      });
      return message.id;
    });
    messageIds.push(messageId);
  }
  await writeAuditLog({
    actorUserId,
    action: "CLUB_INVITES_SENT",
    entityType: "ClubInvite",
    summary: `Sent ${invites.length} club invite${invites.length === 1 ? "" : "s"}.`,
    metadata: { count: invites.length, organizationIds: [...new Set(invites.map((invite) => invite.organizationId))] },
  });
  return { sent: invites.length, messageIds };
}

/** An administrator fixes an invite's email (it goes back to waiting) or cancels it. */
export async function updateClubInvite(
  inviteId: string,
  change: { email: string } | { cancel: true },
  actorUserId: string,
  now = new Date(),
) {
  const prisma = getPrisma();
  const invite = await prisma.clubInvite.findUnique({ where: { id: inviteId }, select: { id: true, status: true, organizationId: true } });
  if (!invite) throw new ClubInviteError("INVITE_NOT_FOUND", "That invite could not be found.");
  if (invite.status !== "PENDING" && invite.status !== "SENT") {
    throw new ClubInviteError("INVITE_NOT_OPEN", "That invite was already accepted or cancelled.");
  }
  if ("cancel" in change) {
    await prisma.clubInvite.update({ where: { id: inviteId }, data: { status: "CANCELLED", cancelledAt: now } });
  } else {
    await prisma.clubInvite.update({ where: { id: inviteId }, data: { email: change.email, status: "PENDING" } });
  }
  await writeAuditLog({
    actorUserId,
    action: "cancel" in change ? "CLUB_INVITE_CANCELLED" : "CLUB_INVITE_EMAIL_CHANGED",
    entityType: "ClubInvite",
    entityId: inviteId,
    summary: "cancel" in change ? "Cancelled a club invite." : "Changed a club invite's email address.",
    metadata: { organizationId: invite.organizationId },
  });
}

const clubTeamInviteSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  sentAt: true,
  sentCount: true,
  expiresAt: true,
} satisfies Prisma.ClubInviteSelect;

function serializeClubTeamInvite(invite: Prisma.ClubInviteGetPayload<{ select: typeof clubTeamInviteSelect }>, now: Date) {
  return {
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role as ClubRole,
    sentAt: invite.sentAt?.toISOString() ?? null,
    sentCount: invite.sentCount,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    expired: Boolean(invite.expiresAt && invite.expiresAt <= now),
  };
}

export type ClubTeamInvite = ReturnType<typeof serializeClubTeamInvite>;

/** A club's own pending invites (#425): only Registrar and Reporter, only what a director or deputy already sent. */
export async function listPendingClubTeamInvites(organizationId: string, now = new Date()) {
  const invites = await getPrisma().clubInvite.findMany({
    where: { organizationId, status: "SENT", role: { in: [...clubAssignableRoles] } },
    orderBy: { sentAt: "desc" },
    select: clubTeamInviteSelect,
  });
  return invites.map((invite) => serializeClubTeamInvite(invite, now));
}

/**
 * A club director or deputy adds someone with no verified account yet
 * (#425): an invite is created and emailed right away, since this is a
 * single, deliberate add rather than a bulk send. Reuses the import
 * invite's model, email, and single-use rules, with its own expiry.
 */
export async function createClubTeamInvite(
  organizationId: string,
  input: { email: string; role: ClubRole; name?: string },
  actorAccountId: string,
  now = new Date(),
) {
  if (!clubRoleIsAssignableByClub(input.role)) {
    throw new ClubInviteError("INVITE_ROLE_NOT_ALLOWED", "Only conference staff can invite directors and deputies.");
  }
  if (!isAccountEmailConfigured()) {
    throw new ClubInviteError("EMAIL_NOT_CONFIGURED", "Account email isn't set up on this server, so invites can't be sent yet.");
  }
  const prisma = getPrisma();
  const club = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, type: true, isActive: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) {
    throw new ClubInviteError("INVITE_NOT_FOUND", "That club could not be found.");
  }
  const email = input.email.trim().toLowerCase();
  // Scoped to club-assignable roles (#425): a pending staff import invite for the same
  // email (always DIRECTOR/DEPUTY) is a different thing and shouldn't invisibly block this.
  const open = await prisma.clubInvite.findFirst({
    where: { organizationId, email, status: { in: ["PENDING", "SENT"] }, role: { in: [...clubAssignableRoles] } },
    select: { id: true },
  });
  if (open) throw new ClubInviteError("INVITE_ALREADY_OPEN", "There's already a pending invite for that email.");

  const sender = getAccountEmailSender();
  const name = input.name?.trim() ?? "";
  const content = inviteEmail({ name, email, clubName: club.name, role: input.role, source: "CLUB" });
  const correlationId = randomUUID();

  return prisma.$transaction(async (tx) => {
    const invite = await tx.clubInvite.create({
      data: {
        organizationId,
        email,
        name,
        role: input.role,
        source: "CLUB",
        createdByAccountId: actorAccountId,
        status: "SENT",
        sentAt: now,
        sentCount: 1,
        expiresAt: clubInviteExpiry(now),
      },
      select: { id: true },
    });
    const message = await tx.messageOutbox.create({
      data: {
        eventId: null,
        templateKey: "CLUB_INVITE",
        recipientKind: "ACCOUNT",
        recipientEmail: email,
        recipientName: name || null,
        senderNameSnapshot: sender.name,
        senderEmailSnapshot: sender.address,
        replyToEmailSnapshot: sender.replyTo,
        subjectSnapshot: content.subject,
        bodyTextSnapshot: content.bodyText,
        metadata: { trigger: "CLUB_INVITE_SENT", accountEmail: true, realDelivery: true, clubInviteId: invite.id },
        idempotencyKey: `club-invite:${invite.id}:${randomUUID()}`,
        correlationId,
        status: "PENDING",
      },
      select: { id: true },
    });
    await tx.clubInvite.update({ where: { id: invite.id }, data: { lastMessageId: message.id } });
    await writeAuditLog({
      action: "CLUB_INVITE_CREATED",
      entityType: "ClubInvite",
      entityId: invite.id,
      summary: `Club leader invited someone as ${clubDirectorRoleLabels[input.role].toLocaleLowerCase("en-US")}.`,
      metadata: { organizationId, role: input.role, actorAttendeeAccountId: actorAccountId },
    }, tx);
    return { inviteId: invite.id, messageId: message.id };
  });
}

/** Statuses from which an invite can still be resent, cancelled, or accepted. */
const OPEN_INVITE_STATUSES = ["PENDING", "SENT"] as const;

/**
 * A club director or deputy resends a pending invite (#425): a fresh expiry
 * and send count, rate-limited so one club can't spam an inbox. The read and
 * the status write happen in one transaction, and the write is guarded on
 * the invite still being open, so two concurrent resends (or a resend racing
 * a cancel or accept) can't both succeed.
 */
export async function resendClubTeamInvite(organizationId: string, inviteId: string, actorAccountId: string, now = new Date()) {
  if (!isAccountEmailConfigured()) {
    throw new ClubInviteError("EMAIL_NOT_CONFIGURED", "Account email isn't set up on this server, so invites can't be sent yet.");
  }
  const prisma = getPrisma();
  const sender = getAccountEmailSender();
  const correlationId = randomUUID();

  return prisma.$transaction(async (tx) => {
    const invite = await tx.clubInvite.findFirst({
      where: { id: inviteId, organizationId },
      select: {
        id: true, email: true, name: true, role: true, status: true, sentAt: true,
        organization: { select: { name: true, isActive: true } },
      },
    });
    if (!invite || !invite.organization.isActive) throw new ClubInviteError("INVITE_NOT_FOUND", "That invite could not be found.");
    if (!clubRoleIsAssignableByClub(invite.role)) {
      throw new ClubInviteError("INVITE_ROLE_NOT_ALLOWED", "Only conference staff can manage that invite.");
    }
    if (invite.status !== "SENT" && invite.status !== "PENDING") {
      throw new ClubInviteError("INVITE_NOT_OPEN", "That invite was already accepted or cancelled.");
    }
    if (invite.sentAt && now.getTime() - invite.sentAt.getTime() < CLUB_INVITE_RESEND_COOLDOWN_MINUTES * 60 * 1000) {
      throw new ClubInviteError("INVITE_RESEND_TOO_SOON", `Wait at least ${CLUB_INVITE_RESEND_COOLDOWN_MINUTES} minutes between resends.`);
    }

    const content = inviteEmail({ name: invite.name, email: invite.email, clubName: invite.organization.name, role: invite.role, source: "CLUB" });

    const guarded = await tx.clubInvite.updateMany({
      where: { id: invite.id, status: { in: [...OPEN_INVITE_STATUSES] } },
      data: { status: "SENT", sentAt: now, sentCount: { increment: 1 }, expiresAt: clubInviteExpiry(now) },
    });
    if (guarded.count === 0) throw new ClubInviteError("INVITE_NOT_OPEN", "That invite was already accepted or cancelled.");

    const message = await tx.messageOutbox.create({
      data: {
        eventId: null,
        templateKey: "CLUB_INVITE",
        recipientKind: "ACCOUNT",
        recipientEmail: invite.email,
        recipientName: invite.name || null,
        senderNameSnapshot: sender.name,
        senderEmailSnapshot: sender.address,
        replyToEmailSnapshot: sender.replyTo,
        subjectSnapshot: content.subject,
        bodyTextSnapshot: content.bodyText,
        metadata: { trigger: "CLUB_INVITE_SENT", accountEmail: true, realDelivery: true, clubInviteId: invite.id },
        idempotencyKey: `club-invite:${invite.id}:${randomUUID()}`,
        correlationId,
        status: "PENDING",
      },
      select: { id: true },
    });
    await tx.clubInvite.update({ where: { id: invite.id }, data: { lastMessageId: message.id } });
    await writeAuditLog({
      action: "CLUB_INVITE_RESENT",
      entityType: "ClubInvite",
      entityId: invite.id,
      summary: "Resent a club invite.",
      metadata: { organizationId, role: invite.role, actorAttendeeAccountId: actorAccountId },
    }, tx);
    return { messageId: message.id };
  });
}

/**
 * A club director or deputy cancels a pending invite (#425). The guarded
 * status write and its audit log share one transaction, so a cancel racing
 * a resend or accept can't leave a CANCELLED invite that was also acted on.
 */
export async function cancelClubTeamInvite(organizationId: string, inviteId: string, actorAccountId: string, now = new Date()) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const invite = await tx.clubInvite.findFirst({
      where: { id: inviteId, organizationId },
      select: { id: true, status: true, role: true },
    });
    if (!invite) throw new ClubInviteError("INVITE_NOT_FOUND", "That invite could not be found.");
    if (!clubRoleIsAssignableByClub(invite.role)) {
      throw new ClubInviteError("INVITE_ROLE_NOT_ALLOWED", "Only conference staff can manage that invite.");
    }
    if (invite.status !== "PENDING" && invite.status !== "SENT") {
      throw new ClubInviteError("INVITE_NOT_OPEN", "That invite was already accepted or cancelled.");
    }
    const guarded = await tx.clubInvite.updateMany({
      where: { id: invite.id, status: { in: [...OPEN_INVITE_STATUSES] } },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    if (guarded.count === 0) throw new ClubInviteError("INVITE_NOT_OPEN", "That invite was already accepted or cancelled.");
    await writeAuditLog({
      action: "CLUB_INVITE_CANCELLED",
      entityType: "ClubInvite",
      entityId: invite.id,
      summary: "Cancelled a club invite.",
      metadata: { organizationId, role: invite.role, actorAttendeeAccountId: actorAccountId },
    }, tx);
  });
}

/** Sent invites waiting for this account, matched on its verified email. Excludes ones that have expired. */
export async function listInvitesForAccount(verifiedEmail: string, now = new Date()) {
  const invites = await getPrisma().clubInvite.findMany({
    where: {
      email: verifiedEmail.trim().toLowerCase(),
      status: "SENT",
      organization: { isActive: true, type: "CLUB" },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { sentAt: "desc" },
    select: { id: true, role: true, organization: { select: { id: true, name: true } } },
  });
  return invites.map((invite) => ({ id: invite.id, role: invite.role, clubId: invite.organization.id, clubName: invite.organization.name }));
}

/**
 * The invited person accepts (#376, #425). The guarded status write happens
 * before the grant is created, in the same transaction as the overlap check
 * and the grant, so two concurrent accepts serialize on the invite row and
 * only one grant is ever created.
 */
export async function acceptClubInvite(inviteId: string, account: { id: string; verifiedEmail: string }, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const invite = await tx.clubInvite.findUnique({
      where: { id: inviteId },
      select: {
        id: true, email: true, role: true, status: true, source: true, expiresAt: true,
        organizationId: true, createdByUserId: true, createdByAccountId: true,
        organization: { select: { isActive: true, type: true } },
      },
    });
    // The same answer for an invite that doesn't exist and one addressed to someone else.
    if (!invite || invite.email !== account.verifiedEmail.trim().toLowerCase() || !invite.organization.isActive || invite.organization.type !== "CLUB") {
      throw new ClubInviteError("INVITE_NOT_FOUND", "That invite could not be found for this account.");
    }
    if (invite.status !== "SENT") throw new ClubInviteError("INVITE_NOT_OPEN", "That invite is no longer open.");
    if (invite.expiresAt && invite.expiresAt <= now) {
      const message = invite.source === "CLUB"
        ? "That invite has expired. Ask your club director to send a new one."
        : "That invite has expired. Ask your conference registrar to send a new one.";
      throw new ClubInviteError("INVITE_EXPIRED", message);
    }
    // Defends the club-assignable rule even if a role or a person's standing changed after the invite was sent.
    if (invite.source === "CLUB" && !clubRoleIsAssignableByClub(invite.role)) {
      throw new ClubInviteError("INVITE_ROLE_NOT_ALLOWED", "That invite's role can no longer be accepted this way.");
    }

    // Guarded before the grant is created: two concurrent accepts of the same invite can't both succeed.
    const guarded = await tx.clubInvite.updateMany({
      where: { id: invite.id, status: "SENT" },
      data: { status: "ACCEPTED", acceptedAt: now, acceptedAccountId: account.id },
    });
    if (guarded.count === 0) throw new ClubInviteError("INVITE_NOT_OPEN", "That invite is no longer open.");

    const current = await tx.clubDirectorGrant.findFirst({
      where: { organizationId: invite.organizationId, attendeeAccountId: account.id, revokedAt: null, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      select: { id: true },
    });
    let grantId = current?.id ?? null;
    if (!current) {
      const grant = await tx.clubDirectorGrant.create({
        data: {
          organizationId: invite.organizationId,
          attendeeAccountId: account.id,
          role: invite.role,
          effectiveFrom: now,
          reason: invite.source === "CLUB" ? "Accepted the club's invite." : "Accepted the conference's club invite.",
          grantedByUserId: invite.createdByUserId,
          grantedByAccountId: invite.createdByAccountId,
        },
        select: { id: true },
      });
      grantId = grant.id;
    }
    await writeAuditLog({
      action: "CLUB_INVITE_ACCEPTED",
      entityType: "ClubInvite",
      entityId: invite.id,
      summary: `Accepted a club invite as ${clubDirectorRoleLabels[invite.role].toLocaleLowerCase("en-US")}.`,
      metadata: { organizationId: invite.organizationId, grantId, alreadyHadRole: Boolean(current), actorAttendeeAccountId: account.id },
    }, tx);
    return { organizationId: invite.organizationId };
  });
}
