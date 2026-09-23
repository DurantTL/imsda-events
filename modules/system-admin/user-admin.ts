import "server-only";

import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { revokeAllUserSessions } from "@/modules/access/session-store";
import { revokeAllAttendeeSessions } from "@/modules/attendee-accounts/session-store";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { sendAccountRecoveryEmail } from "@/modules/communications/account-email-dispatch";

/**
 * System administrator account tools (#386). Two-step sign-in can't be turned
 * off by anyone (decision 2026-09-23); resetting it here is the one audited
 * way back in after a lost device. The person sets it up again at their next
 * sign-in. Every action signs the person out everywhere.
 */

export class UserAdminError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND" | "EMAIL_IN_USE" | "NOT_ON_YOURSELF" | "EMAIL_NOT_CONFIGURED", message: string) {
    super(message);
    this.name = "UserAdminError";
  }
}

export const changeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
}).strict();

// ---- Staff sign-ins -------------------------------------------------------

async function requireStaffUser(userId: string) {
  const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) throw new UserAdminError("ACCOUNT_NOT_FOUND", "That team account could not be found.");
  return user;
}

export async function resetStaffTwoStep(userId: string, actorUserId: string) {
  if (userId === actorUserId) {
    throw new UserAdminError("NOT_ON_YOURSELF", "Ask another system administrator to reset your own two-step sign-in.");
  }
  await requireStaffUser(userId);
  await getPrisma().userMfaEnrollment.deleteMany({ where: { userId } });
  await revokeAllUserSessions(userId);
  await writeAuditLog({
    actorUserId,
    action: "STAFF_MFA_RESET",
    entityType: "User",
    entityId: userId,
    summary: "A system administrator reset a team member's two-step sign-in.",
  });
}

export async function changeStaffEmail(userId: string, email: string, actorUserId: string) {
  await requireStaffUser(userId);
  const taken = await getPrisma().user.findFirst({ where: { email, id: { not: userId } }, select: { id: true } });
  if (taken) throw new UserAdminError("EMAIL_IN_USE", "Another team account already uses that email.");
  await getPrisma().user.update({ where: { id: userId }, data: { email } });
  if (userId !== actorUserId) await revokeAllUserSessions(userId);
  await writeAuditLog({
    actorUserId,
    action: "STAFF_EMAIL_CHANGED",
    entityType: "User",
    entityId: userId,
    summary: "A system administrator changed a team member's sign-in email.",
  });
}

export async function sendStaffPasswordReset(userId: string, actorUserId: string) {
  const user = await requireStaffUser(userId);
  const result = await sendAccountRecoveryEmail(user.email);
  if (!result.configured) throw new UserAdminError("EMAIL_NOT_CONFIGURED", "Account email isn't set up on this server.");
  await writeAuditLog({
    actorUserId,
    action: "STAFF_PASSWORD_RESET_SENT",
    entityType: "User",
    entityId: userId,
    summary: "A system administrator sent a team member a password reset link.",
  });
  return { queued: result.queued };
}

// ---- Attendee accounts ----------------------------------------------------

export async function listAttendeeAccounts(query: string, limit = 50) {
  const text = query.trim().slice(0, 120);
  const accounts = await getPrisma().attendeeAccount.findMany({
    where: text
      ? { OR: [{ email: { contains: text.toLowerCase() } }, { displayName: { contains: text, mode: "insensitive" } }] }
      : undefined,
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      email: true,
      displayName: true,
      status: true,
      disabledAt: true,
      createdAt: true,
      mfaEnrollment: { select: { status: true } },
      _count: { select: { passkeys: { where: { revokedAt: null } } } },
      sessions: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
      clubDirectorGrants: {
        where: { revokedAt: null, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
        select: { role: true, organization: { select: { name: true } } },
      },
    },
  });
  return accounts.map((account) => ({
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    status: account.status,
    disabled: Boolean(account.disabledAt),
    createdAt: account.createdAt.toISOString(),
    lastSignedInAt: account.sessions[0]?.createdAt.toISOString() ?? null,
    authenticatorOn: account.mfaEnrollment?.status === "ACTIVE",
    passkeyCount: account._count.passkeys,
    clubRoles: account.clubDirectorGrants.map((grant) => ({ role: grant.role, clubName: grant.organization.name })),
  }));
}

export type AttendeeAccountSummary = Awaited<ReturnType<typeof listAttendeeAccounts>>[number];

async function requireAttendee(accountId: string) {
  const account = await getPrisma().attendeeAccount.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw new UserAdminError("ACCOUNT_NOT_FOUND", "That account could not be found.");
}

/** Removes the authenticator and every passkey; club roles set one up again at their next sign-in. */
export async function resetAttendeeTwoStep(accountId: string, actorUserId: string, now = new Date()) {
  await requireAttendee(accountId);
  await getPrisma().$transaction([
    getPrisma().attendeeMfaEnrollment.deleteMany({ where: { accountId } }),
    getPrisma().attendeePasskey.updateMany({ where: { accountId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  await revokeAllAttendeeSessions(accountId, now);
  await writeAuditLog({
    actorUserId,
    action: "ATTENDEE_MFA_RESET",
    entityType: "AttendeeAccount",
    entityId: accountId,
    summary: "A system administrator reset an account's two-step sign-in.",
  });
}

export async function signOutAttendeeEverywhere(accountId: string, actorUserId: string) {
  await requireAttendee(accountId);
  await revokeAllAttendeeSessions(accountId);
  await writeAuditLog({
    actorUserId,
    action: "ATTENDEE_SIGNED_OUT_BY_ADMIN",
    entityType: "AttendeeAccount",
    entityId: accountId,
    summary: "A system administrator signed an account out everywhere.",
  });
}

/**
 * Changes an account's email. Registrations are found by verified email, so
 * the account will see registrations made with the new address, not the old.
 */
export async function changeAttendeeEmail(accountId: string, email: string, actorUserId: string) {
  await requireAttendee(accountId);
  const taken = await getPrisma().attendeeAccount.findFirst({ where: { email, id: { not: accountId } }, select: { id: true } });
  if (taken) throw new UserAdminError("EMAIL_IN_USE", "Another account already uses that email.");
  await getPrisma().attendeeAccount.update({ where: { id: accountId }, data: { email } });
  await revokeAllAttendeeSessions(accountId);
  await writeAuditLog({
    actorUserId,
    action: "ATTENDEE_EMAIL_CHANGED",
    entityType: "AttendeeAccount",
    entityId: accountId,
    summary: "A system administrator changed an account's email.",
  });
}
