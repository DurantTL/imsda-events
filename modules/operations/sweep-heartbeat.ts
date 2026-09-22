/**
 * Whether the scheduled outbox sweep is still running.
 *
 * The sweep is also what runs the alert scan, so when it stops nothing else
 * notices: failed email is never retried and no alert is ever raised. Each
 * sweep records when it finished here, and `/api/health` and the command
 * center read it back.
 *
 * This file is pure so the page and the health route share one definition of
 * "stale". The database read and write live in `sweep-heartbeat-repository.ts`.
 */

export const OUTBOX_SWEEP_JOB = "outbox-sweep";

/**
 * Three missed runs at the default five-minute interval. Long enough that one
 * slow or skipped run is not reported, short enough to catch a stopped sweeper
 * well before the thirty-minute "oldest email" alert would have fired.
 */
export const SWEEP_STALE_AFTER_MS = 15 * 60 * 1000;

export type SweepHeartbeatRecord = {
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
};

export type SweepHeartbeat = {
  /**
   * `never`: no sweep has reported since this was added — the sweeper may not
   * be running at all, or may be calling something other than the sweep route.
   * `failing`: the latest run failed.
   */
  status: "ok" | "stale" | "failing" | "never";
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  /** Milliseconds since the last successful sweep. */
  ageMs: number | null;
};

export function assessSweepHeartbeat(
  record: SweepHeartbeatRecord | null,
  now: Date,
  staleAfterMs = SWEEP_STALE_AFTER_MS,
): SweepHeartbeat {
  const lastSucceededAt = record?.lastSucceededAt ?? null;
  const lastFailedAt = record?.lastFailedAt ?? null;
  const ageMs = lastSucceededAt
    ? Math.max(0, now.getTime() - lastSucceededAt.getTime())
    : null;
  const failedMostRecently = lastFailedAt !== null
    && (lastSucceededAt === null || lastFailedAt > lastSucceededAt);

  const status = failedMostRecently
    ? "failing"
    : ageMs === null
      ? "never"
      : ageMs > staleAfterMs
        ? "stale"
        : "ok";

  return {
    status,
    lastSucceededAt: lastSucceededAt?.toISOString() ?? null,
    lastFailedAt: lastFailedAt?.toISOString() ?? null,
    ageMs,
  };
}
