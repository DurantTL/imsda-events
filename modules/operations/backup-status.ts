/**
 * Whether nightly backups are still happening and provably restorable.
 *
 * The backup container records each run in the `BackupRun` table (times, sizes
 * and pass/fail only). `/api/health` reads it back through
 * `backup-status-repository.ts`. This file is pure so the health route, tests
 * and the future System readiness page share one definition of "stale".
 */

export const BACKUP_KIND = "BACKUP";
export const REHEARSAL_KIND = "REHEARSAL";

/** A nightly job plus twelve hours of slack for a slow or late run. */
export const BACKUP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export type BackupRunRecord = {
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  dumpBytes: number | null;
  assetsBytes: number | null;
  offsiteOk: boolean | null;
};

export type BackupRunSummary = {
  /** Newest backup run of any outcome. */
  latest: BackupRunRecord | null;
  /** Newest backup run that succeeded. */
  latestSuccess: BackupRunRecord | null;
  /** Newest backup run whose off-site copy succeeded. */
  latestOffsiteSuccess: Pick<BackupRunRecord, "finishedAt"> | null;
  /** Newest restore rehearsal of any outcome. */
  latestRehearsal: Pick<BackupRunRecord, "finishedAt" | "ok"> | null;
};

export type BackupStatus = {
  /**
   * `never`: nothing has reported yet, so the backup container may not be
   * running. Not treated as degraded, so a fresh deployment is not unhealthy
   * before its first night; the runbook's verification step checks for it.
   * `stale`: no successful backup for 36 hours. `failing`: the latest run
   * failed (but a success is still recent).
   */
  status: "ok" | "stale" | "failing" | "never";
  stale: boolean;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  dumpBytes: number | null;
  assetsBytes: number | null;
  /** Latest run's off-site result; null when none is configured or no run yet. */
  offsiteOk: boolean | null;
  lastOffsiteSuccessAt: string | null;
  lastRehearsalAt: string | null;
  lastRehearsalOk: boolean | null;
  /** True when staleness or any failure needs a human to look. */
  needsAttention: boolean;
};

export function assessBackupStatus(
  summary: BackupRunSummary,
  now: Date,
  staleAfterMs = BACKUP_STALE_AFTER_MS,
): BackupStatus {
  const { latest, latestSuccess, latestOffsiteSuccess, latestRehearsal } = summary;
  const successAge = latestSuccess
    ? Math.max(0, now.getTime() - latestSuccess.finishedAt.getTime())
    : null;
  // Runs that all failed have no success to age; the latest failure shows as
  // `failing`, and the 36 hours start counting from the first success.
  const stale = successAge !== null && successAge > staleAfterMs;
  const failing = latest !== null && !latest.ok;
  const status: BackupStatus["status"] = stale
    ? "stale"
    : failing
      ? "failing"
      : latest === null
        ? "never"
        : "ok";

  const offsiteOk = latest?.offsiteOk ?? null;
  const rehearsalFailed = latestRehearsal !== null && !latestRehearsal.ok;

  return {
    status,
    stale,
    lastSuccessAt: latestSuccess?.finishedAt.toISOString() ?? null,
    lastRunAt: latest?.finishedAt.toISOString() ?? null,
    lastRunOk: latest?.ok ?? null,
    dumpBytes: latestSuccess?.dumpBytes ?? null,
    assetsBytes: latestSuccess?.assetsBytes ?? null,
    offsiteOk,
    lastOffsiteSuccessAt: latestOffsiteSuccess?.finishedAt.toISOString() ?? null,
    lastRehearsalAt: latestRehearsal?.finishedAt.toISOString() ?? null,
    lastRehearsalOk: latestRehearsal?.ok ?? null,
    needsAttention: stale || failing || offsiteOk === false || rehearsalFailed,
  };
}

/** Health reports "degraded" (still HTTP 200) for any of these. */
export function backupStatusDegradesHealth(status: BackupStatus | null) {
  return status?.needsAttention ?? false;
}
