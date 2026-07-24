import "server-only";

import type { AccountTokenPurpose } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { hashPassword, spendPasswordCheck, verifyPassword } from "@/modules/access/passwords";
import { createDatabaseSession } from "@/modules/access/session-store";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RESET_LIFETIME_MINUTES = 30;
/**
 * An invitation is handed over out of band and may sit unopened over a weekend,
 * so it outlives a reset link — but it still expires.
 */
const ACTIVATION_LIFETIME_MINUTES = 7 * 24 * 60;

export type AccountTokenIssue = {
  token: string;
  purpose: AccountTokenPurpose;
  expiresAt: Date;
};

export async function authenticateWithPassword(email: string, password: string, userAgent: string | null) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      accountStatus: true,
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

  const credential = user.credential;
  if (credential.disabledAt || (credential.lockedUntil && credential.lockedUntil > new Date())) {
    await spendPasswordCheck(password);
    return null;
  }

  const valid = await verifyPassword(password, credential.passwordHash);
  if (!valid) {
    const failedAttempts = credential.failedAttempts + 1;
    await getPrisma().authCredential.update({
      where: { id: credential.id },
      data: {
        failedAttempts,
        lockedUntil: failedAttempts >= MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          : null,
      },
    });
    return null;
  }

  await getPrisma().authCredential.update({
    where: { id: credential.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  return createDatabaseSession(user.id, userAgent);
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

  const purpose = options.purpose
    ?? (user.accountStatus === "PENDING_ACTIVATION" ? "ACCOUNT_ACTIVATION" : "PASSWORD_RESET");
  const lifetimeMinutes = purpose === "ACCOUNT_ACTIVATION"
    ? ACTIVATION_LIFETIME_MINUTES
    : RESET_LIFETIME_MINUTES;

  const token = createOpaqueToken();
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + lifetimeMinutes * 60 * 1000);
  await getPrisma().$transaction([
    getPrisma().passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    }),
    getPrisma().passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashOpaqueToken(token), purpose, expiresAt },
    }),
  ]);
  return { token, purpose, expiresAt };
}

/** Back-compatible wrapper: returns the raw token only. */
export async function issuePasswordReset(email: string) {
  return (await issueAccountToken(email))?.token ?? null;
}

/**
 * Describes a token to the page that will consume it, without revealing whose
 * it is. An unknown, used, or expired token is reported the same way.
 */
export async function describeAccountToken(token: string) {
  const record = await getPrisma().passwordResetToken.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: { purpose: true, expiresAt: true, usedAt: true },
  });
  if (!record || record.usedAt || record.expiresAt <= new Date()) return null;
  return { purpose: record.purpose };
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
    return true;
  });
}
