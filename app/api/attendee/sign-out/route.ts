import { cookies } from "next/headers";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  ATTENDEE_PENDING_COOKIE_NAME,
  ATTENDEE_SESSION_COOKIE_NAME,
  revokeAttendeeSession,
} from "@/modules/attendee-accounts/session-store";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  const cookieStore = await cookies();
  await revokeAttendeeSession(cookieStore.get(ATTENDEE_SESSION_COOKIE_NAME)?.value);
  for (const name of [ATTENDEE_SESSION_COOKIE_NAME, ATTENDEE_PENDING_COOKIE_NAME]) {
    cookieStore.set(name, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return Response.json({ ok: true });
}

export const POST = withRequestContext(postHandler);
