import { getPrisma } from "@/lib/prisma";
import { getOutboxQueueHealth } from "@/modules/communications/outbox-sweep";
import { logError } from "@/lib/logger";
import { dispatchUnsuppressedAlert } from "@/modules/operations/alerting";
import { withRequestContext } from "@/lib/request-context";
import { getReleaseIdentity } from "@/lib/release";

/**
 * Liveness and readiness in one response.
 *
 * The database check alone reported `ok` while email delivery was completely
 * broken, so the outbox is checked too. A backed-up queue is `degraded`, not
 * `unavailable`: the container should stay up and keep serving registrations
 * while somebody investigates, so only a database failure returns 503.
 */
async function getHandler() {
  const checkedAt = new Date().toISOString();
  const release = getReleaseIdentity();

  try {
    await getPrisma().$queryRaw`SELECT 1`;
  } catch (error) {
    logError("Health check failed", error);
    // There is nowhere to record suppression when the database is the thing
    // that is down, so this always attempts delivery. An orchestrator polling
    // this endpoint will repeat it, which is the correct amount of noise for a
    // total outage.
    await dispatchUnsuppressedAlert({
      key: "system.database.unavailable",
      severity: "URGENT",
      summary: "The database is unreachable",
      detail: "Registrations, check-in, and payment cannot be recorded until it returns.",
    }).catch(() => undefined);
    return Response.json(
      {
        status: "degraded",
        checkedAt,
        release,
        services: { application: "ok", database: "unavailable" },
      },
      { status: 503 }
    );
  }

  let outbox: Awaited<ReturnType<typeof getOutboxQueueHealth>> | null = null;
  try {
    outbox = await getOutboxQueueHealth();
  } catch (error) {
    logError("Outbox health check failed", error);
  }

  return Response.json({
    status: outbox && outbox.status !== "ok" ? "degraded" : "ok",
    checkedAt,
    release,
    services: {
      application: "ok",
      database: "ok",
      messageOutbox: outbox?.status ?? "unknown",
    },
    messageOutbox: outbox
      ? {
          status: outbox.status,
          reasons: outbox.reasons,
          pending: outbox.pending,
          due: outbox.due,
          processing: outbox.processing,
          failed: outbox.failed,
          oldestDueAgeMs: outbox.oldestDueAgeMs,
          eventsWithDueMessages: outbox.eventsWithDueMessages,
        }
      : null,
  });
}

export const GET = withRequestContext(getHandler);
