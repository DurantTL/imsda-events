import { cookies } from "next/headers";
import {
  AccessDeniedError,
  requireAuthenticatedUser,
} from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  listUserSessions,
  revokeOtherUserSessions,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_LIFETIME_SECONDS,
} from "@/modules/access/session-store";

function apiError(error: unknown, action: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error(`${action} failed`, error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: "SESSION_REQUEST_FAILED", message: "Your signed-in devices could not be loaded." },
    { status: 500 },
  );
}

/** The sessions that can currently sign in as this account. */
export async function GET() {
  try {
    const user = requireAuthenticatedUser(await getCurrentSession());
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    return Response.json({
      sessions: await listUserSessions(user.id, token),
      absoluteLifetimeSeconds: SESSION_LIFETIME_SECONDS,
      idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
    });
  } catch (error) {
    return apiError(error, "Listing sessions");
  }
}

/**
 * Sign out everywhere else. `revokeAllUserSessions` already existed but was
 * only ever called by the password reset path, so a person who suspected a
 * session had been left open somewhere had no way to end it.
 */
export async function DELETE(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  try {
    const user = requireAuthenticatedUser(await getCurrentSession());
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    const revoked = await revokeOtherUserSessions(user.id, token);
    return Response.json({ revoked, sessions: await listUserSessions(user.id, token) });
  } catch (error) {
    return apiError(error, "Revoking sessions");
  }
}
