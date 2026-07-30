import { logError } from "@/lib/logger";
import {
  isAuthorizedSweepRequest,
  sweepOutbox,
} from "@/modules/communications/outbox-sweep";
import { pruneExpiredCommunityContent } from "@/modules/community/repository";
import { runAlertScan } from "@/modules/operations/alert-scan";
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
    });
  } catch (error) {
    logError("Outbox sweep failed", error);
    return Response.json(
      { error: "SWEEP_FAILED", message: "The outbox sweep could not complete." },
      { status: 500 }
    );
  }
}

export const POST = withRequestContext(postHandler);
