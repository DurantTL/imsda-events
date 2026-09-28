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

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    if (!CALENDAR_DATE.test(input.completionDate)) return "Enter the completion date.";
    if (input.completionDate > today) return "The completion date can't be in the future.";
  }
  return null;
}

export type MemberHonorEntryRecord = {
  id: string;
  honorId: string;
  honorCode: string;
  honorName: string;
  status: MemberHonorStatus;
  completionDate: string;
  note: string;
  recordedByName: string;
  recordedAtOrganizationName: string;
  createdAt: string;
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
 * The current status per honor, from append-only history: the latest entry
 * (highest `seq`) for each honor wins. History itself is never edited or
 * removed; a correction is simply a later entry (kept alongside, not in place
 * of, the ones before it).
 */
export function currentHonorsFromHistory(
  entries: readonly MemberHonorEntryRecord[],
): CurrentMemberHonor[] {
  const latest = new Map<string, MemberHonorEntryRecord>();
  // Entries arrive newest-first from the repository; the first one seen per
  // honor is already the latest, so later (older) rows are skipped.
  for (const entry of entries) {
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
