/**
 * Pure pairing and conflict logic for the single-account dry run (#554,
 * ADR 0013). Nothing in this file touches the database, the clock (except the
 * `now` it is handed), or any server-only module, so it is unit-testable with
 * synthetic fixtures.
 *
 * A "pair" is one staff `User` and one `AttendeeAccount` that share a
 * normalised email. The dry run only REPORTS pairs; merging identities is a
 * human gate (AGENTS.md) and is not built here.
 */

export type MfaState = "NONE" | "PENDING" | "ACTIVE";

export type StaffAccountRow = {
  id: string;
  email: string;
  displayName: string;
  accountStatus: "PENDING_ACTIVATION" | "ACTIVE";
  globalRole: "SYSTEM_ADMIN" | null;
  credential: { disabledAt: Date | null; lockedUntil: Date | null } | null;
  mfa: MfaState;
  personLinkPersonId: string | null;
  counts: {
    memberships: number;
    activeMemberships: number;
    passkeys: number;
    sessions: number;
    auditRows: number;
  };
};

export type AttendeeAccountRow = {
  id: string;
  email: string;
  displayName: string;
  status: "PENDING_VERIFICATION" | "ACTIVE";
  emailVerifiedAt: Date | null;
  disabledAt: Date | null;
  credential: { disabledAt: Date | null; lockedUntil: Date | null } | null;
  hasGoogleIdentity: boolean;
  mfa: MfaState;
  personLinkPersonId: string | null;
  counts: {
    registrations: number;
    clubRoles: number;
    areaCoordinator: number;
    passkeys: number;
    sessions: number;
    actorRows: number;
  };
};

export type ConflictSeverity = "blocking" | "review" | "info";

export type ConflictCode =
  | "ATTENDEE_EMAIL_UNVERIFIED"
  | "ATTENDEE_DISABLED"
  | "STAFF_NOT_ACTIVATED"
  | "STAFF_CREDENTIAL_DISABLED"
  | "PERSON_LINK_MISMATCH"
  | "BOTH_HAVE_PASSWORD"
  | "CREDENTIAL_LOCKED"
  | "MFA_BOTH_ENROLLED"
  | "MFA_ATTENDEE_ONLY"
  | "NAME_MISMATCH"
  | "PASSKEYS_ON_BOTH"
  | "ATTENDEE_GOOGLE_IDENTITY";

export type Conflict = {
  code: ConflictCode;
  severity: ConflictSeverity;
  detail: string;
};

export type AccountPair = { staff: StaffAccountRow; attendee: AttendeeAccountRow };

export type AmbiguousGroup = { emailKey: string; staffIds: string[]; attendeeIds: string[] };

export type PairingResult = {
  pairs: AccountPair[];
  staffOnly: StaffAccountRow[];
  attendeeOnly: AttendeeAccountRow[];
  /** Same normalised email shared by more than one row on a side. Never paired. */
  ambiguous: AmbiguousGroup[];
};

/** The same normalisation the sign-in and claiming code uses. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** `j***@example.org`. Never returns more than the first character of the local part. */
export function maskEmail(value: string): string {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Case, spacing, punctuation and diacritics do not make two names different. */
export function nameKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function groupByEmail<T extends { email: string }>(rows: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = normalizeEmail(row.email);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

export function pairAccounts(
  staff: readonly StaffAccountRow[],
  attendees: readonly AttendeeAccountRow[],
): PairingResult {
  const staffByEmail = groupByEmail(staff);
  const attendeesByEmail = groupByEmail(attendees);

  const pairs: AccountPair[] = [];
  const staffOnly: StaffAccountRow[] = [];
  const attendeeOnly: AttendeeAccountRow[] = [];
  const ambiguous: AmbiguousGroup[] = [];

  for (const [key, staffRows] of staffByEmail) {
    const attendeeRows = attendeesByEmail.get(key) ?? [];
    if (attendeeRows.length === 0) {
      staffOnly.push(...staffRows);
    } else if (staffRows.length === 1 && attendeeRows.length === 1) {
      pairs.push({ staff: staffRows[0], attendee: attendeeRows[0] });
    } else {
      ambiguous.push({
        emailKey: key,
        staffIds: staffRows.map((row) => row.id).sort(),
        attendeeIds: attendeeRows.map((row) => row.id).sort(),
      });
    }
  }
  for (const [key, attendeeRows] of attendeesByEmail) {
    if (!staffByEmail.has(key)) attendeeOnly.push(...attendeeRows);
  }

  pairs.sort((a, b) => a.staff.id.localeCompare(b.staff.id));
  ambiguous.sort((a, b) => a.emailKey.localeCompare(b.emailKey));
  return { pairs, staffOnly, attendeeOnly, ambiguous };
}

function credentialUsable(credential: { disabledAt: Date | null } | null) {
  return credential !== null && credential.disabledAt === null;
}

/**
 * Every condition a human has to look at before a pair could be merged.
 * Severity: `blocking` = the pair must not be merged until it is resolved;
 * `review` = merge is possible but a person chooses what survives; `info` =
 * worth knowing, nothing to decide.
 */
export function detectConflicts(pair: AccountPair, now: Date): Conflict[] {
  const { staff, attendee } = pair;
  const conflicts: Conflict[] = [];

  // Verified-email claiming (ADR 0003) is the whole basis for treating the two
  // rows as one person, so an unverified attendee address proves nothing.
  if (attendee.status !== "ACTIVE" || attendee.emailVerifiedAt === null) {
    conflicts.push({
      code: "ATTENDEE_EMAIL_UNVERIFIED",
      severity: "blocking",
      detail: "The attendee email was never verified, so it cannot be treated as the same person as the staff account.",
    });
  }
  if (attendee.disabledAt !== null) {
    conflicts.push({
      code: "ATTENDEE_DISABLED",
      severity: "blocking",
      detail: "The attendee account is disabled. Decide whether that was deliberate before it is combined with an active staff account.",
    });
  }
  if (staff.accountStatus !== "ACTIVE") {
    conflicts.push({
      code: "STAFF_NOT_ACTIVATED",
      severity: "blocking",
      detail: "The staff account was invited but never activated, so its owner has not proven control of the email.",
    });
  }
  if (staff.credential?.disabledAt) {
    conflicts.push({
      code: "STAFF_CREDENTIAL_DISABLED",
      severity: "blocking",
      detail: "The staff password sign-in is disabled. Decide whether the person should regain access through the combined account.",
    });
  }
  if (
    staff.personLinkPersonId !== null
    && attendee.personLinkPersonId !== null
    && staff.personLinkPersonId !== attendee.personLinkPersonId
  ) {
    conflicts.push({
      code: "PERSON_LINK_MISMATCH",
      severity: "blocking",
      detail: "The two accounts are explicitly linked to different Person records.",
    });
  }

  if (credentialUsable(staff.credential) && credentialUsable(attendee.credential)) {
    conflicts.push({
      code: "BOTH_HAVE_PASSWORD",
      severity: "review",
      detail: "Both sides have a password. Hashes are salted, so they cannot be compared; assume they differ. The staff password survives and the attendee password is retired.",
    });
  }
  const locked = (credential: { lockedUntil: Date | null } | null) =>
    credential?.lockedUntil != null && credential.lockedUntil > now;
  if (locked(staff.credential) || locked(attendee.credential)) {
    conflicts.push({
      code: "CREDENTIAL_LOCKED",
      severity: "review",
      detail: "A password lockout is active on at least one side. Wait for it to clear or reset it deliberately.",
    });
  }

  if (staff.mfa === "ACTIVE" && attendee.mfa === "ACTIVE") {
    conflicts.push({
      code: "MFA_BOTH_ENROLLED",
      severity: "review",
      detail: "Both sides have a confirmed authenticator. Only one secret can survive; the staff one does, and the attendee secret and recovery codes are retired.",
    });
  } else if (staff.mfa !== "ACTIVE" && attendee.mfa === "ACTIVE") {
    conflicts.push({
      code: "MFA_ATTENDEE_ONLY",
      severity: "review",
      detail: "Only the attendee side has a confirmed authenticator, but staff access requires one. The person must enrol on the staff side.",
    });
  }

  if (nameKey(staff.displayName) !== nameKey(attendee.displayName)) {
    conflicts.push({
      code: "NAME_MISMATCH",
      severity: "review",
      detail: "The display names differ after ignoring case, spacing and accents. A person chooses the surviving name.",
    });
  }

  if (staff.counts.passkeys > 0 && attendee.counts.passkeys > 0) {
    conflicts.push({
      code: "PASSKEYS_ON_BOTH",
      severity: "info",
      detail: "Both sides hold passkeys. Passkeys are independent credentials and are moved, never merged.",
    });
  }
  if (attendee.hasGoogleIdentity) {
    conflicts.push({
      code: "ATTENDEE_GOOGLE_IDENTITY",
      severity: "info",
      detail: "The attendee side signs in with Google. That method may open the attendee side only, never a staff session.",
    });
  }

  return conflicts;
}

export type PairStatus = "clean" | "needs-review" | "blocked";

export function pairStatus(conflicts: readonly Conflict[]): PairStatus {
  if (conflicts.some((conflict) => conflict.severity === "blocking")) return "blocked";
  if (conflicts.some((conflict) => conflict.severity === "review")) return "needs-review";
  return "clean";
}

export type PairReport = {
  staffUserId: string;
  attendeeAccountId: string;
  email: string;
  status: PairStatus;
  conflicts: Conflict[];
  staff: StaffAccountRow["counts"] & { globalRole: "SYSTEM_ADMIN" | null };
  attendee: AttendeeAccountRow["counts"];
};

export type DryRunReport = {
  generatedAt: string;
  readOnly: true;
  emailsShown: boolean;
  summary: {
    staffAccounts: number;
    attendeeAccounts: number;
    pairs: number;
    pairsByStatus: Record<PairStatus, number>;
    staffOnly: number;
    attendeeOnly: number;
    ambiguousGroups: number;
    conflictCounts: Partial<Record<ConflictCode, number>>;
  };
  pairs: PairReport[];
  /** `email` is masked unless emails are shown; the raw `emailKey` is never reported. */
  ambiguous: Array<{ email: string; staffIds: string[]; attendeeIds: string[] }>;
};

export function buildReport(
  staff: readonly StaffAccountRow[],
  attendees: readonly AttendeeAccountRow[],
  options: { showEmails: boolean; now: Date },
): DryRunReport {
  const pairing = pairAccounts(staff, attendees);
  const render = (email: string) => (options.showEmails ? normalizeEmail(email) : maskEmail(email));

  const conflictCounts: Partial<Record<ConflictCode, number>> = {};
  const pairsByStatus: Record<PairStatus, number> = { clean: 0, "needs-review": 0, blocked: 0 };
  const pairs: PairReport[] = pairing.pairs.map((pair) => {
    const conflicts = detectConflicts(pair, options.now);
    for (const conflict of conflicts) {
      conflictCounts[conflict.code] = (conflictCounts[conflict.code] ?? 0) + 1;
    }
    const status = pairStatus(conflicts);
    pairsByStatus[status] += 1;
    return {
      staffUserId: pair.staff.id,
      attendeeAccountId: pair.attendee.id,
      email: render(pair.staff.email),
      status,
      conflicts,
      staff: { ...pair.staff.counts, globalRole: pair.staff.globalRole },
      attendee: pair.attendee.counts,
    };
  });

  return {
    generatedAt: options.now.toISOString(),
    readOnly: true,
    emailsShown: options.showEmails,
    summary: {
      staffAccounts: staff.length,
      attendeeAccounts: attendees.length,
      pairs: pairs.length,
      pairsByStatus,
      staffOnly: pairing.staffOnly.length,
      attendeeOnly: pairing.attendeeOnly.length,
      ambiguousGroups: pairing.ambiguous.length,
      conflictCounts,
    },
    pairs,
    ambiguous: pairing.ambiguous.map((group) => ({
      email: render(group.emailKey),
      staffIds: group.staffIds,
      attendeeIds: group.attendeeIds,
    })),
  };
}

export const SHOW_EMAILS_WARNING =
  "WARNING: --show-emails prints full email addresses. This output is personal data. "
  + "Do not paste it into issues, pull requests, chat, logs or commits (AGENTS.md data rules).";

export function formatReportText(report: DryRunReport): string {
  const { summary } = report;
  const lines: string[] = [
    "Single-account dry run (read-only, no row was changed)",
    `Generated: ${report.generatedAt}`,
    report.emailsShown
      ? "Emails: FULL (personal data, do not share)"
      : "Emails: masked (use --show-emails only on a trusted terminal)",
    "",
    `Staff accounts:      ${summary.staffAccounts}`,
    `Attendee accounts:   ${summary.attendeeAccounts}`,
    `Pairs (same email):  ${summary.pairs}`,
    `  clean:             ${summary.pairsByStatus.clean}`,
    `  needs review:      ${summary.pairsByStatus["needs-review"]}`,
    `  blocked:           ${summary.pairsByStatus.blocked}`,
    `Staff-only:          ${summary.staffOnly}`,
    `Attendee-only:       ${summary.attendeeOnly}`,
    `Ambiguous groups:    ${summary.ambiguousGroups}`,
    "",
    "Conflicts by kind:",
  ];
  const kinds = Object.entries(summary.conflictCounts).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length === 0) lines.push("  none");
  for (const [code, count] of kinds) lines.push(`  ${code}: ${count}`);

  for (const pair of report.pairs) {
    lines.push(
      "",
      `Pair ${pair.email}  [${pair.status}]  user=${pair.staffUserId}  attendee=${pair.attendeeAccountId}`,
      `  staff:    memberships=${pair.staff.activeMemberships}/${pair.staff.memberships} active/total, `
        + `globalRole=${pair.staff.globalRole ?? "none"}, passkeys=${pair.staff.passkeys}, `
        + `sessions=${pair.staff.sessions}, auditRows=${pair.staff.auditRows}`,
      `  attendee: registrations=${pair.attendee.registrations}, clubRoles=${pair.attendee.clubRoles}, `
        + `areaCoordinator=${pair.attendee.areaCoordinator}, passkeys=${pair.attendee.passkeys}, `
        + `sessions=${pair.attendee.sessions}, actorRows=${pair.attendee.actorRows}`,
    );
    for (const conflict of pair.conflicts) {
      lines.push(`  - ${conflict.severity.toUpperCase()} ${conflict.code}: ${conflict.detail}`);
    }
  }
  for (const group of report.ambiguous) {
    lines.push(
      "",
      `Ambiguous ${group.email}: staff=${group.staffIds.join(",")} attendee=${group.attendeeIds.join(",")} (not paired; a person must resolve the duplicates first)`,
    );
  }
  return `${lines.join("\n")}\n`;
}
