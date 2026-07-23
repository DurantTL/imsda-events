import "server-only";

import { getPrisma } from "@/lib/prisma";
import { hashPassword, spendPasswordCheck, verifyPassword } from "@/modules/access/passwords";
import { createDatabaseSession } from "@/modules/access/session-store";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RESET_LIFETIME_MINUTES = 30;

export async function authenticateWithPassword(email: string, password: string, userAgent: string | null) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      credential: {
        select: { id: true, passwordHash: true, failedAttempts: true, lockedUntil: true, disabledAt: true },
      },
    },
  });

  if (!user?.credential) {
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

export async function issuePasswordReset(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, credential: { select: { disabledAt: true } } },
  });

  await spendPasswordCheck(normalizedEmail);

  if (!user?.credential || user.credential.disabledAt) {
    return null;
  }

  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + RESET_LIFETIME_MINUTES * 60 * 1000);
  await getPrisma().$transaction([
    getPrisma().passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    getPrisma().passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashOpaqueToken(token), expiresAt },
    }),
  ]);
  return token;
}

export async function resetPassword(token: string, password: string) {
  const tokenHash = hashOpaqueToken(token);
  const reset = await getPrisma().passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
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
    await tx.userSession.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return true;
  });
}
