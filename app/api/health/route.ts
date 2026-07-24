import { getPrisma } from "@/lib/prisma";
import { getOutboxQueueHealth } from "@/modules/communications/outbox-sweep";
import { logError } from "@/lib/logger";

/**
 * Liveness and readiness in one response.
 *
 * The database check alone reported `ok` while email delivery was completely
 * broken, so the outbox is checked too. A backed-up queue is `degraded`, not
 * `unavailable`: the container should stay up and keep serving registrations
 * while somebody investigates, so only a database failure returns 503.
 */
export async function GET() {
  const checkedAt = new Date().toISOString();

  try {
    await getPrisma().$queryRaw`SELECT 1`;
  } catch (error) {
    logError("Health check failed", error);
    return Response.json(
      {
        status: "degraded",
        checkedAt,
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
