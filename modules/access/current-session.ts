import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { getPrisma } from "@/lib/prisma";
import type { Session } from "@/modules/access/authorization";
import { SESSION_COOKIE_NAME } from "@/modules/access/session-store";
import { hashOpaqueToken } from "@/modules/access/tokens";

export const getCurrentSession = cache(async (): Promise<Session> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return { user: null };

  const session = await getPrisma().userSession.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: {
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          globalRole: true,
          credential: { select: { disabledAt: true } },
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.credential || session.user.credential.disabledAt) {
    return { user: null };
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
