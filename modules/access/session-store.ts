import "server-only";

import { getPrisma } from "@/lib/prisma";
import { createOpaqueToken, hashOpaqueToken, hashUserAgent } from "@/modules/access/tokens";

export const SESSION_COOKIE_NAME = "imsda_session";
export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

export async function createDatabaseSession(userId: string, userAgent: string | null) {
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000);
  await getPrisma().userSession.create({
    data: {
      userId,
      tokenHash: hashOpaqueToken(token),
      expiresAt,
      userAgentHash: hashUserAgent(userAgent),
    },
  });
  return { token, expiresAt };
}

export async function revokeDatabaseSession(token: string | undefined) {
  if (!token) return;
  await getPrisma().userSession.updateMany({
    where: { tokenHash: hashOpaqueToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string) {
  await getPrisma().userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
