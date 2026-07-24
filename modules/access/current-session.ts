import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { getPrisma } from "@/lib/prisma";
import type { Session } from "@/modules/access/authorization";
import {
  isSessionIdle,
  SESSION_COOKIE_NAME,
  shouldTouchSession,
  touchDatabaseSession,
} from "@/modules/access/session-store";
import { hashOpaqueToken } from "@/modules/access/tokens";

export const getCurrentSession = cache(async (): Promise<Session> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return { user: null };

  const tokenHash = hashOpaqueToken(token);
  const session = await getPrisma().userSession.findUnique({
    where: { tokenHash },
    select: {
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          globalRole: true,
          accountStatus: true,
          credential: { select: { disabledAt: true } },
        },
      },
    },
  });

  const now = new Date();
  if (
    !session
    || session.revokedAt
    || session.expiresAt <= now
    || !session.user.credential
    || session.user.credential.disabledAt
    || session.user.accountStatus !== "ACTIVE"
  ) {
    return { user: null };
  }

  // An absolute expiry alone left a session usable for its full eight hours
  // after the person walked away from a shared check-in tablet.
  if (isSessionIdle(session.lastSeenAt, now)) return { user: null };

  if (shouldTouchSession(session.lastSeenAt, now)) {
    await touchDatabaseSession(tokenHash, session.lastSeenAt, now);
  }

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      globalRole: session.user.globalRole,
    },
  };
});
