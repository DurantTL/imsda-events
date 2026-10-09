/**
 * The one seam for backup status on the System readiness page (#870).
 *
 * The `BackupRun` table (#875) is not on main yet, so this returns `null` and the two backup items stay manual
 * ticks. A follow-up replaces the body with a read of the latest successful backup and restore test; once this
 * returns a value, `evaluateBackupItems` in `readiness-checks.ts` shows those items as checked automatically.
 */
export type BackupEvidence = {
  lastBackupAt: Date | null;
  lastRestoreTestAt: Date | null;
};

export async function getAutomaticBackupEvidence(): Promise<BackupEvidence | null> {
  return null;
}
