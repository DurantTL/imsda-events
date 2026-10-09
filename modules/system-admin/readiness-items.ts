/**
 * The System readiness checklist (#870), defined in code with stable keys.
 *
 * The keys are stored with each tick and written to the audit log, so they must never be renamed or reused: add a
 * new item with a new key, and retire an old one by removing it here (an old tick for an unknown key is simply not
 * shown). Wording summarises the server checklist (`docs/SERVER-SECURITY-CHECKLIST.md`) and issue #416. It never
 * names a host, an account or a secret, only where evidence is kept.
 *
 * Automatic items are computed by `readiness-checks.ts`; manual items are ticked by a system administrator. Ticking
 * only records that a person did the work. Nothing here deploys, migrates, sends or unlocks anything.
 */

export type ManualReadinessGroup = "server" | "go-live";

export type ManualReadinessItem = {
  key: string;
  group: ManualReadinessGroup;
  title: string;
  detail: string;
  /** Where the full instructions live, as plain text. */
  reference: string;
};

export const manualReadinessGroups: ReadonlyArray<{ id: ManualReadinessGroup; title: string }> = [
  { id: "server", title: "Server and backups" },
  { id: "go-live", title: "Go-live sign-offs" },
];

export const manualReadinessItems: readonly ManualReadinessItem[] = [
  {
    key: "backup-server-built",
    group: "server",
    title: "External backup server exists",
    detail: "An on-premises machine, separate from the events server, with disk encryption and a short written list of who can log in.",
    reference: "Server security checklist, item 1",
  },
  {
    key: "key-copy-restored",
    group: "server",
    title: "Encryption key copy on the backup server, test-restored",
    detail: "A copy of the encryption key is kept apart from the database dumps and has been test-restored on a test copy of the app. Record where it is kept, never the value.",
    reference: "Server security checklist, items 2 and 3",
  },
  {
    key: "backup-offsite",
    group: "server",
    title: "Nightly database backups leave the host",
    detail: "A backup from the last 24 hours is on the backup server. A follow-up can make this an automatic check.",
    reference: "Server security checklist, item 4",
  },
  {
    key: "restore-rehearsal",
    group: "server",
    title: "Restore rehearsal passes",
    detail: "The unattended restore rehearsal has passed recently and the date is on the log. A follow-up can make this an automatic check.",
    reference: "Server security checklist, item 5",
  },
  {
    key: "database-private",
    group: "server",
    title: "Database reachable only from the app",
    detail: "A connection to the database port from outside the server fails, and the development override is not loaded on the server.",
    reference: "Server security checklist, item 6",
  },
  {
    key: "https-end-to-end",
    group: "server",
    title: "HTTPS end to end",
    detail: "The site shows a valid certificate and plain HTTP redirects to HTTPS.",
    reference: "Server security checklist, item 7",
  },
  {
    key: "key-access-locked",
    group: "server",
    title: "Access to the encryption key is locked down",
    detail: "SSH keys only, the key is not shown in a hosting panel (or the panel requires MFA), the master copy is under a separate account, and the daily file-refresh job is running.",
    reference: "Server security checklist, item 11",
  },
  {
    key: "key-rotation-written",
    group: "server",
    title: "Key rotation procedure written",
    detail: "The procedure is written and kept with the key copy.",
    reference: "Server security checklist, item 9",
  },
  {
    key: "director-invites-sent",
    group: "go-live",
    title: "Director invites sent",
    detail: "Club director invitations have been sent from the invites page.",
    reference: "Issue #416",
  },
  {
    key: "director-removal-note-sent",
    group: "go-live",
    title: "Director onboarding note sent",
    detail: "Directors have been told the difference between deactivating and removing a member.",
    reference: "Server security checklist, item 10",
  },
  {
    key: "sterling-rules-signed-off",
    group: "go-live",
    title: "Sterling Volunteers check rules signed off",
    detail: "The rules as built (only dates stored, non-clear statuses never stored, flags only, nothing blocked) are approved.",
    reference: "Issue #218",
  },
  {
    key: "health-records-signed-off",
    group: "go-live",
    title: "Health records decisions signed off",
    detail: "The ten decisions in the health records report are made.",
    reference: "Issue #389",
  },
  {
    key: "wr26-signed-off",
    group: "go-live",
    title: "WR26 sign-off",
    detail: "Women's Retreat 2026 setup is signed off by the event owner.",
    reference: "Issue #306",
  },
];

/** Keys for the two backup items, so the single seam in `readiness-backup.ts` can take them over. */
export const BACKUP_ITEM_KEYS = ["backup-offsite", "restore-rehearsal"] as const;

export function findManualReadinessItem(key: string) {
  return manualReadinessItems.find((item) => item.key === key) ?? null;
}
