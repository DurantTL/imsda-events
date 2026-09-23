import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

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

function inviteEmail(input: { name: string; email: string; clubName: string; role: "DIRECTOR" | "DEPUTY" | "REGISTRAR" | "REPORTER" }) {
  const accountUrl = new URL("/account", getServerEnv().APP_BASE_URL).toString();
  const role = clubDirectorRoleLabels[input.role].toLocaleLowerCase("en-US");
  return {
    subject: `You're invited to manage ${input.clubName} on IMSDA Events`,
    bodyText: [
      `Hello ${input.name.trim() || "there"},`,
      "",
      `The Iowa-Missouri Conference has set up ${input.clubName} on IMSDA Events and invited you as the club's ${role}.`,
      "",
      "To accept:",
      `1. Go to ${accountUrl}`,
      `2. Sign in, or create an account, using this email address: ${input.email}`,
      "3. On your account page, choose Accept next to the club invite.",
      "",
      "Your club's roster from this year's registration is already there. Please add each person's birth date as you go; until then they're marked \"birth date needed\".",
      "",
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
    select: { id: true, email: true, name: true, role: true, organizationId: true, organization: { select: { name: true } } },
  });
  if (invites.length === 0) throw new ClubInviteError("NOTHING_TO_SEND", "There are no invites waiting to be sent.");

  const correlationId = randomUUID();
  const messageIds: string[] = [];
  for (const invite of invites) {
    const content = inviteEmail({ name: invite.name, email: invite.email, clubName: invite.organization.name, role: invite.role });
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
      await tx.clubInvite.update({
        where: { id: invite.id },
        data: { status: "SENT", sentAt: now, sentCount: { increment: 1 }, lastMessageId: message.id },
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

/** Sent invites waiting for this account, matched on its verified email. */
export async function listInvitesForAccount(verifiedEmail: string) {
  const invites = await getPrisma().clubInvite.findMany({
    where: { email: verifiedEmail.trim().toLowerCase(), status: "SENT", organization: { isActive: true, type: "CLUB" } },
    orderBy: { sentAt: "desc" },
    select: { id: true, role: true, organization: { select: { id: true, name: true } } },
  });
  return invites.map((invite) => ({ id: invite.id, role: invite.role, clubId: invite.organization.id, clubName: invite.organization.name }));
}

export async function acceptClubInvite(inviteId: string, account: { id: string; verifiedEmail: string }, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const invite = await tx.clubInvite.findUnique({
      where: { id: inviteId },
      select: { id: true, email: true, role: true, status: true, organizationId: true, createdByUserId: true, organization: { select: { isActive: true, type: true } } },
    });
    // The same answer for an invite that doesn't exist and one addressed to someone else.
    if (!invite || invite.email !== account.verifiedEmail.trim().toLowerCase() || !invite.organization.isActive || invite.organization.type !== "CLUB") {
      throw new ClubInviteError("INVITE_NOT_FOUND", "That invite could not be found for this account.");
    }
    if (invite.status !== "SENT") throw new ClubInviteError("INVITE_NOT_OPEN", "That invite is no longer open.");

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
          reason: "Accepted the conference's club invite.",
          grantedByUserId: invite.createdByUserId,
        },
        select: { id: true },
      });
      grantId = grant.id;
    }
    await tx.clubInvite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedAt: now, acceptedAccountId: account.id } });
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
