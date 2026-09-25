import { NextResponse, type NextRequest } from "next/server";
import {
  LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS,
  LAST_USED_EVENT_COOKIE_NAME,
} from "@/modules/events/last-used-event-cookie";

/**
 * Remembers the last event a staff member viewed (#108 queue 1), so a
 * multi-event account that signs back in later lands on that event instead
 * of the event picker every time.
 *
 * This only records a hint for `resolveLoginDestination` — it never grants
 * access. `resolveLoginDestination` re-checks it against the account's real
 * active event memberships before using it, and every workspace page still
 * authorizes the chosen event through `resolveEventContext` regardless of
 * what this cookie says.
 */
export function proxy(request: NextRequest) {
  const eventId = request.nextUrl.searchParams.get("event");
  if (!eventId) return NextResponse.next();

  const response = NextResponse.next();
  response.cookies.set(LAST_USED_EVENT_COOKIE_NAME, eventId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

export const config = {
  matcher: [
    "/overview",
    "/people",
    "/finance/:path*",
    "/check-in",
    "/communications",
    "/community",
    "/staff",
    "/imports/:path*",
    "/registration-builder",
    "/more/:path*",
    "/admin/:path*",
  ],
};
