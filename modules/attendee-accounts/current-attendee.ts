import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { getPrisma } from "@/lib/prisma";
import { getCurrentSession } from "@/modules/access/current-session";
import { hashOpaqueToken } from "@/modules/access/tokens";
import {
  ATTENDEE_SESSION_COOKIE_NAME,
  isAttendeeSessionIdle,
  shouldTouchAttendeeSession,
  touchAttendeeSession,
} from "@/modules/attendee-accounts/session-store";

/**
 * Resolves the signed-in registrant, and only ever a registrant.
 *
 * The counterpart to `getCurrentSession`, kept apart from it on purpose (ADR
 * 0003). This reads a different cookie and a different table, so it cannot
 * return a staff user and `getCurrentSession` cannot return an attendee — not
 * by convention, but because neither token can reach the other's lookup.
 *
 * `verifiedEmail` is deliberately part of the resolved identity rather than
 * something callers fetch separately. It is the entire claim an account has, so
 * a page that lists registrations should not be able to obtain it by any route
 * that skipped the checks below.
 */

export type AttendeeSession = {
  account: {
    id: string;
    verifiedEmail: string;
    displayName: string;
  } | null;
  via: "attendee" | "staff" | null;
  sessionId: string | null;
};

async function attendeeAccountForStaff(): Promise<AttendeeSession> {
  const { user } = await getCurrentSession();
  if (!user) return { account: null, via: null, sessionId: null };
  const account = await getPrisma().attendeeAccount.findUnique({
    where: { email: user.email.trim().toLowerCase() },
    select: {
      id: true,
      email: true,
      displayName: true,
      status: true,
      emailVerifiedAt: true,
      disabledAt: true,
    },
  });
  if (
    !account
    || account.disabledAt
    || account.status !== "ACTIVE"
    || !account.emailVerifiedAt
  ) {
    return { account: null, via: null, sessionId: null };
  }
  return {
    account: {
      id: account.id,
      verifiedEmail: account.email,
      displayName: account.displayName,
    },
    via: "staff",
    sessionId: null,
  };
}

export const getCurrentAttendee = cache(async (): Promise<AttendeeSession> => {
  const token = (await cookies()).get(ATTENDEE_SESSION_COOKIE_NAME)?.value;
  if (!token) return attendeeAccountForStaff();

  const tokenHash = hashOpaqueToken(token);
  const session = await getPrisma().attendeeSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      account: {
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          emailVerifiedAt: true,
          disabledAt: true,
        },
      },
    },
  });

  const now = new Date();
  if (
    !session
    || session.revokedAt
    || session.expiresAt <= now
    // The account-level flag, not the credential's. An account that only ever
    // signed in with Google has no credential row, and reading the disable off
    // one would have made such an account impossible to shut off — and, before
    // that, impossible to resolve at all.
    || session.account.disabledAt
    || session.account.status !== "ACTIVE"
    // Belt and braces with `status`, because this is the field the claim rests
    // on: an account that somehow reached ACTIVE without a verification date
    // must reach nothing rather than reach everything at that address.
    || !session.account.emailVerifiedAt
  ) {
    return attendeeAccountForStaff();
  }

  if (isAttendeeSessionIdle(session.lastSeenAt, now)) return attendeeAccountForStaff();

  if (shouldTouchAttendeeSession(session.lastSeenAt, now)) {
    await touchAttendeeSession(tokenHash, session.lastSeenAt, now);
  }

  return {
    account: {
      id: session.account.id,
      verifiedEmail: session.account.email,
      displayName: session.account.displayName,
    },
    via: "attendee",
    sessionId: session.id,
  };
});
