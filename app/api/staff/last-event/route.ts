import { cookies } from "next/headers";
import { z } from "zod";
import { AccessDeniedError, requireEventMembership } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  isEventIdFormat,
  LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS,
  LAST_USED_EVENT_COOKIE_NAME,
} from "@/modules/events/last-used-event-cookie";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const lastEventSchema = z.object({
  eventId: z.string().refine(isEventIdFormat),
});

/**
 * Remembers the event a staff member just picked — in the workspace event
 * switcher or on `/select-event` — so a multi-event account lands back on it
 * at its next sign-in (#108 queue 1).
 *
 * Written only here, and only after the signed-in account is confirmed to be
 * able to open the event. It stays a hint: `resolveLoginDestination`
 * re-checks it against the account's active memberships at sign-in.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  try {
    const session = await getCurrentSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const parsed = lastEventSchema.safeParse(body);
    // Authentication is checked first so a signed-out caller always sees 401,
    // whatever it sent.
    if (!session.user) {
      throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
    }
    if (!parsed.success) {
      return Response.json(
        { error: "INVALID_EVENT", message: "Choose an event to continue." },
        { status: 400 },
      );
    }

    await requireEventMembership(session, parsed.data.eventId, findActiveMembership);
    // Sign-in routing ignores the hint for system administrators, so there's nothing to record.
    if (session.user.globalRole === "SYSTEM_ADMIN") return Response.json({ ok: true });

    (await cookies()).set(LAST_USED_EVENT_COOKIE_NAME, parsed.data.eventId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS,
    });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Recording the last-used event failed", error);
    return Response.json(
      { error: "LAST_EVENT_FAILED", message: "Your event choice could not be remembered." },
      { status: 500 },
    );
  }
}

export const POST = withRequestContext(postHandler);
