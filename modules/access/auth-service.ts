import "server-only";

import type { AccountTokenPurpose, GlobalRole } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { hashPassword, spendPasswordCheck, verifyPassword } from "@/modules/access/passwords";
import { createDatabaseSession } from "@/modules/access/session-store";
import { mfaGateFor } from "@/modules/access/mfa-rules";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { scheduleLockoutEmails } from "@/modules/communications/lockout-email";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const RESET_LIFETIME_MINUTES = 30;
/**
 * An invitation may sit unopened over a weekend, so it outlives a reset link —
 * but it still expires.
 */
export const ACTIVATION_LIFETIME_MINUTES = 7 * 24 * 60;

export type AccountTokenIssue = {
  token: string;
  purpose: AccountTokenPurpose;
  expiresAt: Date;
};

/**
 * A correct password is not, on its own, a session.
 *
 * For an account that carries a second factor — or that must, by role, and has
 * not enrolled one — this returns a gate instead. The caller turns that into a
 * challenge. Nothing downstream ever sees a session that skipped the gate.
 */
export type PasswordAuthentication =
  | {
      outcome: "session";
      userId: string;
      globalRole: GlobalRole | null;
      session: { token: string; expiresAt: Date };
    }
  | { outcome: "mfa"; userId: string; gate: "challenge" | "enrol" }
  /**
   * A privileged account whose only second factor is a passkey (#429). The
   * password alone can't finish sign-in, and it can't enrol an authenticator
   * either — that would let a phished password stand in for the passkey.
   */
  | { outcome: "passkey_required"; userId: string };

export async function authenticateWithPassword(
  email: string,
  password: string,
  userAgent: string | null,
): Promise<PasswordAuthentication | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      accountStatus: true,
      globalRole: true,
      memberships: { where: { status: "ACTIVE" }, select: { role: true } },
      mfaEnrollment: { select: { status: true } },
      passkeys: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      credential: {
        select: { id: true, passwordHash: true, failedAttempts: true, lockedUntil: true, disabledAt: true },
      },
    },
  });

  if (!user?.credential) {
    await spendPasswordCheck(password);
    return null;
  }

  // A pending account holds a random hash that nobody knows. Rejecting it here
  // keeps that state explicit rather than relying on the hash being unguessable.
  if (user.accountStatus !== "ACTIVE") {
    await spendPasswordCheck(password);
    return null;
  }

  if (!(await checkPasswordWithLockout(user.credential, user.id, password))) return null;

  const subject = {
    globalRole: user.globalRole,
    activeEventRoles: user.memberships.map((membership) => membership.role),
  };
  const gate = mfaGateFor(subject, user.mfaEnrollment);
  // A passkey is this account's second factor: sign in with it, not by
  // enrolling a new authenticator on the strength of the password (#429).
  if (gate.kind === "enrol" && user.passkeys.length > 0) {
    return { outcome: "passkey_required", userId: user.id };
  }
  if (gate.kind !== "not_required") {
    return { outcome: "mfa", userId: user.id, gate: gate.kind };
  }

  return {
    outcome: "session",
    userId: user.id,
    globalRole: user.globalRole,
    session: await createDatabaseSession(user.id, userAgent),
  };
}

type LockableCredential = {
  id: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  disabledAt: Date | null;
};

/**
 * The one password check, shared by sign-in and by the confirm-it's-you step
 * on sign-in changes (#429): a disabled or locked credential never verifies,
 * a wrong password counts toward the lockout, and a right one clears it.
 *
 * The lockout email (#456) is scheduled from here, the one place both
 * callers cross through, and only by the request that wins the conditional
 * claim on the not-locked -> locked transition: the counter is incremented
 * atomically, and the lock is set by an `updateMany` that only matches while
 * the counter is at the threshold and no live lock stands. Setting the lock
 * resets the counter, so a re-lock after expiry needs five new wrong
 * passwords. The email itself runs after the response (`after()`), so the
 * locking attempt is indistinguishable from any other failure.
 */
async function checkPasswordWithLockout(credential: LockableCredential, userId: string, password: string) {
  if (credential.disabledAt || (credential.lockedUntil && credential.lockedUntil > new Date())) {
    await spendPasswordCheck(password);
    return false;
  }

  const valid = await verifyPassword(password, credential.passwordHash);
  if (!valid) {
    const now = new Date();
    // Counted only while no live lock stands, so wrong passwords that raced
    // past the check above while another request set the lock cannot re-arm
    // the counter for the next lock (#456 re-review).
    const counted = await getPrisma().authCredential.updateMany({
      where: { id: credential.id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data: { failedAttempts: { increment: 1 } },
    });
    if (counted.count === 1) {
      const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000);
      const claimed = await getPrisma().authCredential.updateMany({
        where: {
          id: credential.id,
          failedAttempts: { gte: MAX_FAILED_ATTEMPTS },
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: { lockedUntil, failedAttempts: 0 },
      });
      if (claimed.count === 1) {
        scheduleLockoutEmails({
          audience: "STAFF",
          kind: "PASSWORD",
          accountUserId: userId,
          lockedUntil,
          now,
        });
      }
    }
    return false;
  }

  await getPrisma().authCredential.update({
    where: { id: credential.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  return true;
}

/**
 * Re-checks a signed-in staff member's current password, for a change to how
 * the account signs in (#429). Runs through exactly the same verification and
 * lockout counter as {@link authenticateWithPassword}; it never issues a
 * session and never reveals why it failed.
 */
export async function verifyCurrentPassword(userId: string, password: string): Promise<boolean> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: {
      accountStatus: true,
      credential: {
        select: { id: true, passwordHash: true, failedAttempts: true, lockedUntil: true, disabledAt: true },
      },
    },
  });
  if (!user?.credential || user.accountStatus !== "ACTIVE") {
    await spendPasswordCheck(password);
    return false;
  }
  return checkPasswordWithLockout(user.credential, userId, password);
}

/**
 * Issues the one-time token that lets someone set a password. An account that
 * has never been activated gets an activation token with a longer life; an
 * active account gets a reset token. Both are stored as a hash only and both
 * are completed by {@link resetPassword}.
 */
export async function issueAccountToken(
  email: string,
  options: { purpose?: AccountTokenPurpose; now?: Date } = {},
): Promise<AccountTokenIssue | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, accountStatus: true, credential: { select: { disabledAt: true } } },
  });

  await spendPasswordCheck(normalizedEmail);

  if (!user?.credential || user.credential.disabledAt) {
    return null;
  }

  return issueAccountTokenForUser(user.id, {
    purpose: options.purpose
      ?? (user.accountStatus === "PENDING_ACTIVATION" ? "ACCOUNT_ACTIVATION" : "PASSWORD_RESET"),
    now: options.now,
  });
}

/**
 * Issues against a known user id, skipping the address lookup and the dummy
 * password work that only exists to keep {@link issueAccountToken} constant
 * time for an unknown address. Email delivery calls this at send time so the
 * raw token never has to be stored in the outbox alongside the message.
 */
export async function issueAccountTokenForUser(
  userId: string,
  options: { purpose: AccountTokenPurpose; now?: Date },
): Promise<AccountTokenIssue> {
  const lifetimeMinutes = options.purpose === "ACCOUNT_ACTIVATION"
    ? ACTIVATION_LIFETIME_MINUTES
    : RESET_LIFETIME_MINUTES;

  const token = createOpaqueToken();
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + lifetimeMinutes * 60 * 1000);
  await getPrisma().$transaction([
    getPrisma().passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    }),
    getPrisma().passwordResetToken.create({
      data: { userId, tokenHash: hashOpaqueToken(token), purpose: options.purpose, expiresAt },
    }),
  ]);
  return { token, purpose: options.purpose, expiresAt };
}

/**
 * Retires a token that was issued but never handed over — an email that failed
 * definitively, for instance. Spending it is safe to repeat.
 */
export async function revokeAccountToken(token: string, now = new Date()) {
  await getPrisma().passwordResetToken.updateMany({
    where: { tokenHash: hashOpaqueToken(token), usedAt: null },
    data: { usedAt: now },
  });
}

/** Back-compatible wrapper: returns the raw token only. */
export async function issuePasswordReset(email: string) {
  return (await issueAccountToken(email))?.token ?? null;
}

/**
 * Describes a live token: what it is for, and whose account it belongs to. An
 * unknown, used, or expired token is reported the same way — null.
 *
 * `owner` is for server-side use only — the password policy rejects a password
 * containing the account holder's name or address, which it cannot do without
 * knowing them. It must not be sent to the browser; the page that consumes a
 * token reads `purpose` alone.
 */
export async function describeAccountToken(token: string) {
  const record = await getPrisma().passwordResetToken.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: {
      purpose: true,
      expiresAt: true,
      usedAt: true,
      user: { select: { email: true, displayName: true } },
    },
  });
  if (!record || record.usedAt || record.expiresAt <= new Date()) return null;
  return {
    purpose: record.purpose,
    owner: {
      email: record.user?.email ?? null,
      displayName: record.user?.displayName ?? null,
    },
  };
}

export async function resetPassword(token: string, password: string) {
  const tokenHash = hashOpaqueToken(token);
  const reset = await getPrisma().passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true, purpose: true },
  });
  if (!reset || reset.usedAt || reset.expiresAt <= new Date()) return false;

  const passwordHash = await hashPassword(password);
  const now = new Date();
  return getPrisma().$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return false;
    await tx.authCredential.update({
      where: { userId: reset.userId },
      data: { passwordHash, passwordUpdatedAt: now, failedAttempts: 0, lockedUntil: null },
    });
    // Choosing a password is what activates an invited account. Doing it here
    // means the two can never drift apart.
    await tx.user.updateMany({
      where: { id: reset.userId, accountStatus: "PENDING_ACTIVATION" },
      data: { accountStatus: "ACTIVE", activatedAt: now },
    });
    await tx.userSession.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    // A reset (often after a suspected compromise) removes every way in, not
    // only the password: staff passkeys are revoked too, and added again after
    // signing in (#453). A password lockout still blocks passkey sign-in.
    const passkeys = await tx.userPasskey.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (passkeys.count > 0) {
      await writeAuditLog({
        actorUserId: reset.userId,
        action: "USER_PASSKEYS_REVOKED_ON_PASSWORD_RESET",
        entityType: "User",
        entityId: reset.userId,
        summary: `Password reset revoked ${passkeys.count} staff passkey${passkeys.count === 1 ? "" : "s"}.`,
        metadata: { passkeysRevoked: passkeys.count },
      }, tx);
    }
    return true;
  });
}
