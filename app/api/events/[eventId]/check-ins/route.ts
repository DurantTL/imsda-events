import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { listCheckInChanges } from "@/modules/checkin/live-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * The live check-in list's delta poll (#825): which attendees were checked in
 * or out since `since`, as a few bytes of `[attendeeId, checkedInAt|null]`
 * pairs. Deliberately not rate limited: it is authenticated, permission
 * checked, cheap, and a desk of 2-4 devices polls it every few seconds.
 */
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

/** Anything older than this is clamped, so a stale tab cannot ask for the whole event's history. */
const MAXIMUM_LOOKBACK_MS = 6 * 60 * 60 * 1_000;

async function getHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_CHECK_IN", findActiveMembership);
    const raw = new URL(request.url).searchParams.get("since");
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(parsed)) {
      return Response.json({
        error: "INVALID_SINCE",
        message: "A valid since time is required.",
      }, { status: 400, headers });
    }
    const earliest = Date.now() - MAXIMUM_LOOKBACK_MS;
    const since = new Date(Math.max(parsed, earliest));
    return Response.json(await listCheckInChanges(eventId, since), { headers });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    }
    logError("Live check-in list failed", error);
    return Response.json({
      error: "CHECK_IN_CHANGES_FAILED",
      message: "Other devices' check-ins could not be loaded. This list will try again.",
    }, { status: 500, headers });
  }
}

export const GET = withRequestContext(getHandler);
