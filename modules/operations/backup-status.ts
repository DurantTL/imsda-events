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

/** The migration that creates the status table; its age anchors "never". */
export const BACKUP_MIGRATION_NAME = "20261014100000_backup_run";

/** Weekly rehearsal plus a day of slack. */
export const REHEARSAL_STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

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
  /** Newest restore rehearsal that succeeded. */
  latestRehearsalSuccess: Pick<BackupRunRecord, "finishedAt"> | null;
  /**
   * When the status-table migration finished. Anchors "never": a deployment
   * that has had the table for 36 hours and still has no backup is stale.
   */
  migrationFinishedAt: Date | null;
};

export type BackupStatus = {
  /**
   * `never`: nothing has reported yet, within 36 hours of the status table
   * being created (a fresh deployment gets its first night). After that, with
   * still nothing recorded, it is `stale`.
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

/** What the public, unauthenticated health endpoint may show. */
export type PublicBackupStatus = Pick<
  BackupStatus,
  "status" | "stale" | "needsAttention" | "lastSuccessAt" | "lastRehearsalAt"
>;

export function toPublicBackupStatus(status: BackupStatus): PublicBackupStatus {
  return {
    status: status.status,
    stale: status.stale,
    needsAttention: status.needsAttention,
    lastSuccessAt: status.lastSuccessAt,
    lastRehearsalAt: status.lastRehearsalAt,
  };
}

export function assessBackupStatus(
  summary: BackupRunSummary,
  now: Date,
  staleAfterMs = BACKUP_STALE_AFTER_MS,
): BackupStatus {
  const {
    latest,
    latestSuccess,
    latestOffsiteSuccess,
    latestRehearsal,
    latestRehearsalSuccess,
    migrationFinishedAt,
  } = summary;
  const age = (date: Date | null | undefined) =>
    date ? Math.max(0, now.getTime() - date.getTime()) : null;

  const successAge = age(latestSuccess?.finishedAt);
  // With no success ever, the clock starts when the table was created, so a
  // backup container that was never started cannot stay green forever.
  const neverRan = latest === null;
  const stale = successAge !== null
    ? successAge > staleAfterMs
    : (age(migrationFinishedAt) ?? 0) > staleAfterMs;
  const failing = latest !== null && !latest.ok;
  const status: BackupStatus["status"] = stale
    ? "stale"
    : failing
      ? "failing"
      : neverRan
        ? "never"
        : "ok";

  // Off-site: the scheduler records false when an off-site copy is required
  // (BACKUP_REQUIRE_OFFSITE) and was skipped or failed. It also needs attention
  // when copies worked once but have stopped for 36 hours.
  const offsiteOk = latest?.offsiteOk ?? null;
  const offsiteAge = age(latestOffsiteSuccess?.finishedAt);
  const offsiteStopped = offsiteAge !== null && offsiteAge > staleAfterMs;

  const rehearsalFailed = latestRehearsal !== null && !latestRehearsal.ok;
  const rehearsalReference = latestRehearsalSuccess?.finishedAt ?? migrationFinishedAt;
  const rehearsalOverdue = (age(rehearsalReference) ?? 0) > REHEARSAL_STALE_AFTER_MS;

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
    needsAttention:
      stale || failing || offsiteOk === false || offsiteStopped
      || rehearsalFailed || rehearsalOverdue,
  };
}

/** Health reports "degraded" (still HTTP 200) for any of these. */
export function backupStatusDegradesHealth(status: BackupStatus | null) {
  return status?.needsAttention ?? false;
}
