import type { SweepHeartbeat } from "@/modules/operations/sweep-heartbeat";
import type { BackupEvidence } from "./readiness-backup";
import { BACKUP_ITEM_KEYS } from "./readiness-items";

/**
 * The automatic half of the System readiness page (#870). Pure: the repository gathers the facts, this turns them
 * into rows. A fact is only ever a count, a yes/no, a date or a name of a staff account. Nothing here receives a key,
 * a token, an address or a connection string, so there is nothing to leak.
 */

export type AutomaticStatus = "ok" | "attention" | "info" | "unknown";

export type AutomaticReadinessRow = {
  key: string;
  title: string;
  status: AutomaticStatus;
  summary: string;
  /** Staff names to act on, such as administrators without MFA. */
  people: string[];
};

export type ReadinessFacts = {
  admins: Array<{ displayName: string; hasMfaOrPasskey: boolean }> | null;
  /** Migration folders on disk that the database has not finished applying; `null` when it could not be read. */
  pendingMigrations: string[] | null;
  sweep: SweepHeartbeat | null;
  encryptionKeyConfigured: boolean;
  email: {
    deliveryConfigured: boolean;
    senderConfigured: boolean;
    /** False for a placeholder such as example.org, which cannot send or receive real mail. */
    senderDeliverable: boolean;
  };
  square: { environment: "sandbox" | "production"; productionUnlocked: boolean };
  backup: BackupEvidence | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function age(from: Date, now: Date) {
  const days = Math.floor((now.getTime() - from.getTime()) / DAY_MS);
  if (days < 1) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function sweepRow(sweep: SweepHeartbeat | null): AutomaticReadinessRow {
  const base = { key: "outbox-sweeper", title: "Email queue sweeper is running", people: [] as string[] };
  if (!sweep) return { ...base, status: "unknown", summary: "The sweeper status could not be read." };
  if (sweep.status === "ok") return { ...base, status: "ok", summary: "The sweeper ran successfully in the last 15 minutes." };
  if (sweep.status === "never") return { ...base, status: "attention", summary: "The sweeper has never reported. Check that the scheduled job is calling it." };
  if (sweep.status === "failing") return { ...base, status: "attention", summary: "The latest sweeper run failed." };
  return { ...base, status: "attention", summary: "The sweeper has not succeeded in over 15 minutes." };
}

/**
 * Backup items are manual until `getAutomaticBackupEvidence` returns something. When it does, the two backup rows
 * move here and the manual versions are hidden by the caller (see `automaticBackupKeys`).
 */
export function evaluateBackupItems(backup: BackupEvidence | null, now: Date): AutomaticReadinessRow[] {
  if (!backup) return [];
  const backupFresh = backup.lastBackupAt !== null && now.getTime() - backup.lastBackupAt.getTime() <= 2 * DAY_MS;
  const restoreFresh = backup.lastRestoreTestAt !== null && now.getTime() - backup.lastRestoreTestAt.getTime() <= 14 * DAY_MS;
  return [
    {
      key: "backup-offsite",
      title: "Last successful backup",
      status: backupFresh ? "ok" : "attention",
      summary: backup.lastBackupAt ? `Last successful backup ${age(backup.lastBackupAt, now)}.` : "No successful backup is recorded.",
      people: [],
    },
    {
      key: "restore-rehearsal",
      title: "Last restore test",
      status: restoreFresh ? "ok" : "attention",
      summary: backup.lastRestoreTestAt ? `Last restore test ${age(backup.lastRestoreTestAt, now)}.` : "No restore test is recorded.",
      people: [],
    },
  ];
}

export function evaluateAutomaticChecks(facts: ReadinessFacts, now: Date): AutomaticReadinessRow[] {
  const rows: AutomaticReadinessRow[] = [];

  if (!facts.admins) {
    rows.push({ key: "admins-mfa", title: "Every system administrator has MFA or a passkey", status: "unknown", summary: "The administrator list could not be read.", people: [] });
  } else {
    const without = facts.admins.filter((admin) => !admin.hasMfaOrPasskey).map((admin) => admin.displayName).sort();
    const total = facts.admins.length;
    rows.push({
      key: "admins-mfa",
      title: "Every system administrator has MFA or a passkey",
      status: total === 0 ? "attention" : without.length === 0 ? "ok" : "attention",
      summary: total === 0
        ? "No active system administrators were found."
        : without.length === 0
          ? `All ${total} active system ${total === 1 ? "administrator has" : "administrators have"} MFA or a passkey.`
          : `${total - without.length} of ${total} active system administrators have MFA or a passkey.`,
      people: without,
    });
  }

  if (facts.pendingMigrations === null) {
    rows.push({ key: "migrations", title: "No database migrations are pending", status: "unknown", summary: "Migration status could not be read.", people: [] });
  } else {
    const count = facts.pendingMigrations.length;
    rows.push({
      key: "migrations",
      title: "No database migrations are pending",
      status: count === 0 ? "ok" : "attention",
      summary: count === 0 ? "The database has every migration this release ships." : `${count} migration${count === 1 ? " is" : "s are"} not applied yet.`,
      people: [],
    });
  }

  rows.push(sweepRow(facts.sweep));

  rows.push({
    key: "encryption-key",
    title: "Encryption key is configured",
    status: facts.encryptionKeyConfigured ? "ok" : "attention",
    summary: facts.encryptionKeyConfigured ? "Yes. The value is never shown." : "No. Set it on the server before anyone enrols in MFA or birth dates are stored.",
    people: [],
  });

  const { email } = facts;
  rows.push({
    key: "email-provider",
    title: "Email provider is configured",
    status: email.deliveryConfigured ? "ok" : "attention",
    summary: email.deliveryConfigured ? "Yes." : "No. Event email is captured locally and nothing is sent.",
    people: [],
  });
  rows.push({
    key: "email-sender",
    title: "Sender address is a real, deliverable address",
    status: email.senderConfigured && email.senderDeliverable ? "ok" : "attention",
    summary: !email.senderConfigured
      ? "No sender address is set."
      : email.senderDeliverable
        ? "A sender address is set and is not a placeholder. The app cannot check the provider's domain verification itself, so confirm that with the provider."
        : "The sender address is a placeholder domain that cannot send real mail.",
    people: [],
  });

  rows.push({
    key: "square-environment",
    title: "Square environment",
    status: "info",
    summary: facts.square.environment === "production"
      ? facts.square.productionUnlocked
        ? "Production, and production is unlocked."
        : "Production is selected but not unlocked, so card payments stay blocked."
      : "Sandbox. Production is not selected.",
    people: [],
  });

  rows.push(...evaluateBackupItems(facts.backup, now));
  return rows;
}

/** Manual items that an automatic row has taken over, so they are not listed twice. */
export function automaticBackupKeys(backup: BackupEvidence | null): ReadonlySet<string> {
  return new Set<string>(backup ? BACKUP_ITEM_KEYS : []);
}
