import { isCalendarDate } from "@/modules/calendar/domain";
import { clubYearMonths } from "@/modules/club-reports/domain";
import { toCsv } from "@/modules/reporting/csv";

/**
 * A member's year-round honor record (#486). Pure rules shared by the
 * repository and the club's Honors screens. The record follows the durable
 * `Person`, never a `ClubRosterMember` row (see the repository for why), so
 * nothing here ever takes a club-year or a roster-member id as the identity.
 */

export const memberHonorStatusLabels = {
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
} as const;

export type MemberHonorStatus = keyof typeof memberHonorStatusLabels;

/**
 * Why a new entry can't be recorded, or null. Completed work needs a
 * completion date that isn't in the future; in-progress work has none yet
 * (a correction that reopens a completed honor clears it by recording a new
 * IN_PROGRESS entry).
 */
export function memberHonorEntryProblem(
  input: { status: MemberHonorStatus; completionDate: string },
  today: string,
) {
  if (input.status === "COMPLETED") {
    if (!input.completionDate) return "Enter the completion date.";
    // A real calendar day: 2026-13-45 or 2026-02-30 is refused, not stored.
    if (!isCalendarDate(input.completionDate)) return "Enter a real completion date.";
    if (input.completionDate > today) return "The completion date can't be in the future.";
  }
  return null;
}

/** Who voided an entry, when, and why (#591). Shown struck through in history. */
export type MemberHonorEntryVoidRecord = {
  reason: string;
  voidedByName: string;
  voidedAt: string;
};

export type MemberHonorEntryRecord = {
  id: string;
  honorId: string;
  honorCode: string;
  honorName: string;
  status: MemberHonorStatus;
  completionDate: string;
  note: string;
  recordedByName: string;
  /** The club that recorded the entry: only that club may void it (#591). */
  recordedAtOrganizationId: string;
  recordedAtOrganizationName: string;
  createdAt: string;
  /** Null unless the entry was voided; the entry itself is never changed. */
  voided: MemberHonorEntryVoidRecord | null;
};

export type CurrentMemberHonor = {
  honorId: string;
  honorCode: string;
  honorName: string;
  status: MemberHonorStatus;
  completionDate: string;
  createdAt: string;
};

/**
 * The current status per honor, from append-only history: the latest
 * non-voided entry (highest `seq`) for each honor wins (#591). History itself
 * is never edited or removed; a correction is simply a later entry, and a
 * voided entry is skipped, so voiding the latest makes the previous
 * non-voided one current, or leaves no status when none is left.
 */
export function currentHonorsFromHistory(
  entries: readonly MemberHonorEntryRecord[],
): CurrentMemberHonor[] {
  const latest = new Map<string, MemberHonorEntryRecord>();
  // Entries arrive newest-first from the repository; the first non-voided one
  // seen per honor is already the latest, so later (older) rows are skipped.
  for (const entry of entries) {
    if (entry.voided) continue;
    if (!latest.has(entry.honorId)) latest.set(entry.honorId, entry);
  }
  return [...latest.values()]
    .map((entry) => ({
      honorId: entry.honorId,
      honorCode: entry.honorCode,
      honorName: entry.honorName,
      status: entry.status,
      completionDate: entry.completionDate,
      createdAt: entry.createdAt,
    }))
    .sort((a, b) => a.honorName.localeCompare(b.honorName));
}

export type ClubHonorsRow = {
  memberId: string;
  firstName: string;
  lastName: string;
  /** The roster's own grouping (#375): the closest thing to a "unit" today. */
  classLevel: string | null;
  honors: CurrentMemberHonor[];
};

/** Filters for the club Honors page: by honor, status, and unit (class level). */
export type ClubHonorsFilter = { honorId?: string; status?: MemberHonorStatus; classLevel?: string };

export function filterClubHonorsRows(rows: readonly ClubHonorsRow[], filter: ClubHonorsFilter): ClubHonorsRow[] {
  return rows
    .filter((row) => !filter.classLevel || row.classLevel === filter.classLevel)
    .map((row) => ({
      ...row,
      honors: row.honors.filter((honor) => (
        (!filter.honorId || honor.honorId === filter.honorId)
        && (!filter.status || honor.status === filter.status)
      )),
    }))
    .filter((row) => !(filter.honorId || filter.status) || row.honors.length > 0);
}

/** The roster card's own shape (#486): current honors keyed by roster member id. */
export function honorSummaryByMemberId(rows: readonly ClubHonorsRow[]): Record<string, CurrentMemberHonor[]> {
  return Object.fromEntries(rows.map((row) => [row.memberId, row.honors]));
}

export type HonorYearSummary = { inProgress: number; completedThisYear: number };

/**
 * Honors tile counts for the club-year dashboard (#488): how many honors are
 * in progress right now, and how many were completed since this club year
 * began. Built from `listClubHonorsPage`'s rows — the same read the roster
 * card and the Honors page already use, no new query. Counts only, never a
 * name: safe for a tile even though `listClubHonorsPage` itself carries names.
 *
 * A completed honor's status can be years old (#486: honors are kept across
 * years, keyed to the person), so only entries completed on or after this
 * club year's first day count as "recently completed" here. In-progress
 * work has no date to filter by, so every current one counts.
 */
export function honorYearSummary(rows: readonly ClubHonorsRow[], clubYear: string): HonorYearSummary {
  const yearStart = `${clubYearMonths(clubYear)[0]}-01`;
  let inProgress = 0;
  let completedThisYear = 0;
  for (const row of rows) {
    for (const honor of row.honors) {
      if (honor.status === "IN_PROGRESS") inProgress += 1;
      else if (honor.status === "COMPLETED" && honor.completionDate >= yearStart) completedThisYear += 1;
    }
  }
  return { inProgress, completedThisYear };
}

/** Names and honors only — no birth dates, ages, or any medical field. */
export function clubHonorsCsv(rows: readonly ClubHonorsRow[]) {
  const out: Array<Array<string | number>> = [["Last name", "First name", "Honor", "Status", "Completion date"]];
  for (const row of rows) {
    if (row.honors.length === 0) {
      out.push([row.lastName, row.firstName, "", "", ""]);
      continue;
    }
    for (const honor of row.honors) {
      out.push([row.lastName, row.firstName, honor.honorName, memberHonorStatusLabels[honor.status], honor.completionDate]);
    }
  }
  return toCsv(out);
}

/** The reason must be 3 to 500 characters once trimmed (#591). */
export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 500;
