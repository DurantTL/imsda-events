import { logError } from "@/lib/logger";
import {
  isAuthorizedSweepRequest,
  sweepOutbox,
} from "@/modules/communications/outbox-sweep";
import { refreshDueCalendarFeeds } from "@/modules/calendar/feeds";
import { sendDueLocationWaitlistDigests } from "@/modules/event-locations/waitlist-digest";
import { pruneExpiredCommunityContent } from "@/modules/community/repository";
import { runAlertScan } from "@/modules/operations/alert-scan";
import { sweepHostedCheckouts } from "@/modules/payments/square-hosted-invalidation";
import { recordSweepHeartbeat } from "@/modules/operations/sweep-heartbeat-repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * The scheduled caller for the message outbox.
 *
 * This is a machine endpoint: it carries a bearer token instead of a session
 * and deliberately skips the same-origin check, which exists to protect
 * cookie-authenticated routes from a browser. Without a configured
 * `OUTBOX_SWEEP_TOKEN` it is always 401 — never open by omission.
 */
async function postHandler(request: Request) {
  if (!isAuthorizedSweepRequest(request)) {
    return Response.json(
      { error: "SWEEP_NOT_AUTHORIZED", message: "A valid sweep credential is required." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  try {
    const result = await sweepOutbox();
    // Recorded before the alert scan so a scan failure cannot hide a sweep
    // that worked, and never allowed to fail the sweep itself.
    await recordSweepHeartbeat("SUCCEEDED").catch((error) => {
      logError("Could not record the outbox sweep heartbeat", error);
    });
    // The sweep already runs every few minutes, which makes it the natural
    // place to read the system's signals: one cron, one credential, and the
    // queue's state is known here anyway. A scan failure must not make a
    // successful sweep look failed.
    const alerts = await runAlertScan().catch((error) => {
      logError("The alert scan failed after a successful sweep", error);
      return null;
    });
    const communityRetention = await pruneExpiredCommunityContent().catch((error) => {
      logError("Community retention sweep failed after a successful outbox sweep", error);
      return null;
    });
    // The daily location waitlist digest to Area Coordinators and event staff
    // (#599). It waits for its morning send time (Central) and sends at most one
    // email per person per date, so running it on every sweep is safe. Its
    // failure must not make a successful sweep look failed.
    const locationWaitlistDigest = await sendDueLocationWaitlistDigests().catch((error) => {
      logError("The location waitlist digest failed after a successful outbox sweep", error);
      return null;
    });
    // Imported Google calendars (#444): feeds whose own refresh interval has
    // passed, a few per sweep. Each feed's failure is recorded on the feed; none
    // of it may make a successful sweep look failed.
    const calendarFeeds = await refreshDueCalendarFeeds().catch((error) => {
      logError("The calendar feed refresh failed after a successful outbox sweep", error);
      return null;
    });
    // Pay on Square links (#327): withdraw expired or stale ones and retry any deletion Square has
    // not confirmed. Square has no link expiry of its own, so this is what makes expiry real.
    // Its failure must not make a successful sweep look failed.
    const hostedLinks = await sweepHostedCheckouts().catch((error) => {
      logError("The Pay on Square link sweep failed after a successful outbox sweep", error);
      return null;
    });
    return Response.json({
      sweptEventCount: result.sweptEventIds.length,
      sweptAccountMessages: result.sweptAccountMessages,
      skipped: result.skipped,
      queueBefore: result.snapshotBefore,
      alerts: alerts && {
        sent: alerts.sent.map((alert) => alert.key),
        suppressed: alerts.suppressed.map((alert) => alert.key),
        undelivered: alerts.undelivered.map((alert) => alert.key),
        cleared: alerts.cleared,
      },
      communityRetention,
      calendarFeeds,
      hostedLinks,
      locationWaitlistDigest: locationWaitlistDigest && {
        status: locationWaitlistDigest.status,
        changesCovered: locationWaitlistDigest.changesCovered,
        recipients: locationWaitlistDigest.recipients,
        delivered: locationWaitlistDigest.delivered,
      },
    });
  } catch (error) {
    logError("Outbox sweep failed", error);
    await recordSweepHeartbeat("FAILED").catch(() => undefined);
    return Response.json(
      { error: "SWEEP_FAILED", message: "The outbox sweep could not complete." },
      { status: 500 }
    );
  }
}

export const POST = withRequestContext(postHandler);
