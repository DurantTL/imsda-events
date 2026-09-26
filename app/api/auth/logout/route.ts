import { cookies } from "next/headers";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { revokeDatabaseSession, SESSION_COOKIE_NAME } from "@/modules/access/session-store";
import { getCurrentSession } from "@/modules/access/current-session";
import { endActiveActAsOnSignOut } from "@/modules/organizations/staff-act-as";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  // Signing out ends any active act-as (#442) — resolved before the session
  // is revoked, since it's keyed by this session's id.
  const { sessionId } = await getCurrentSession();
  if (sessionId) await endActiveActAsOnSignOut(sessionId);

  const cookieStore = await cookies();
  await revokeDatabaseSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return Response.json({ ok: true });
}

export const POST = withRequestContext(postHandler);
