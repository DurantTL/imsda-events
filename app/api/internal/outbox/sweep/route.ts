import { logError } from "@/lib/logger";
import {
  isAuthorizedSweepRequest,
  sweepOutbox,
} from "@/modules/communications/outbox-sweep";

/**
 * The scheduled caller for the message outbox.
 *
 * This is a machine endpoint: it carries a bearer token instead of a session
 * and deliberately skips the same-origin check, which exists to protect
 * cookie-authenticated routes from a browser. Without a configured
 * `OUTBOX_SWEEP_TOKEN` it is always 401 — never open by omission.
 */
export async function POST(request: Request) {
  if (!isAuthorizedSweepRequest(request)) {
    return Response.json(
      { error: "SWEEP_NOT_AUTHORIZED", message: "A valid sweep credential is required." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  try {
    const result = await sweepOutbox();
    return Response.json({
      sweptEventCount: result.sweptEventIds.length,
      sweptAccountMessages: result.sweptAccountMessages,
      skipped: result.skipped,
      queueBefore: result.snapshotBefore,
    });
  } catch (error) {
    logError("Outbox sweep failed", error);
    return Response.json(
      { error: "SWEEP_FAILED", message: "The outbox sweep could not complete." },
      { status: 500 }
    );
  }
}
