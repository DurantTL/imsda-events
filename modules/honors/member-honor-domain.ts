import { makeSearchMatcher } from "@/lib/search-match";
import { isCalendarDate } from "@/modules/calendar/domain";
import { clubYearMonths } from "@/modules/club-reports/domain";
import { clubClassLevelLabels } from "@/modules/club-rosters/domain";
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
 * Why a new entry can't be recorded, or null. The completion date is optional
 * (a director often doesn't know it): when one is given it must be a real
 * calendar day that isn't in the future. In-progress work has no date; a
 * correction that reopens a completed honor records a new IN_PROGRESS entry.
 */
export function memberHonorEntryProblem(
  input: { status: MemberHonorStatus; completionDate: string },
  today: string,
) {
  if (input.status === "COMPLETED" && input.completionDate) {
    // A real calendar day: 2026-13-45 or 2026-02-30 is refused, not stored.
    if (!isCalendarDate(input.completionDate)) return "Enter a real completion date.";
    if (input.completionDate > today) return "The completion date can't be in the future.";
  }
  return null;
}

/**
 * The reason written on an in-progress entry that a Completed entry replaced
 * (#790). It is an ordinary void row, so history shows the entry struck
 * through with this reason, and it is recognizable as a system action.
 */
export const SUPERSEDED_VOID_REASON = "Superseded: this honor was recorded as completed.";

/**
 * Which of one person's earlier entries for a single honor a new Completed
 * entry replaces (#790): every non-voided IN_PROGRESS entry newer than the
 * latest non-voided COMPLETED one. `entries` are for one person and one honor,
 * recorded before the new entry, newest first (highest `seq` first). Older
 * in-progress entries already sitting behind a completion are left alone.
 */
export function supersededInProgressEntryIds(
  entries: ReadonlyArray<{ id: string; status: MemberHonorStatus; voided: boolean }>,
): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.voided) continue;
    if (entry.status === "COMPLETED") break;
    ids.push(entry.id);
  }
  return ids;
}

/** Honors shown before a pill list collapses behind "Show all (N)" (#790). */
export const HONOR_PILL_COLLAPSE_LIMIT = 6;

/** How many honor pills to show, and whether to offer the Show all / Show fewer toggle (#790). */
export function honorPillWindow<T>(items: readonly T[], expanded: boolean, limit = HONOR_PILL_COLLAPSE_LIMIT) {
  const collapsible = items.length > limit;
  return {
    visible: collapsible && !expanded ? items.slice(0, limit) : [...items],
    collapsible,
    hiddenCount: collapsible && !expanded ? items.length - limit : 0,
    total: items.length,
  };
}

/** Filters the Honors page's people by a name search: case-insensitive, first and last name in any order (#790). */
export function filterRowsByPersonName<T extends { firstName: string; lastName: string }>(rows: readonly T[], search: string): T[] {
  const matches = makeSearchMatcher(search);
  return rows.filter((row) => matches([row.firstName, row.lastName]));
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

/**
 * The honor history popup lists live entries only (#819). A voided entry (and
 * the in-progress one a completion replaced) stays in the database with its
 * audit row; it just isn't shown. Counts, CSVs and reports already skip them.
 */
export function visibleHonorHistory<T extends { voided: unknown }>(history: readonly T[]): T[] {
  return history.filter((entry) => !entry.voided);
}

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

/**
 * The CSV's columns (#811). The first five keep their original positions, so a spreadsheet that reads by
 * position still works; "Current class", the page's other column, is added at the end. The name is split
 * in two so it sorts in a spreadsheet, and there is one line per honor.
 */
export const CLUB_HONORS_CSV_HEADERS = ["Last name", "First name", "Honor", "Status", "Completion date", "Current class"] as const;

/** Names, class and honors only — no birth dates, ages, or any medical field. */
export function clubHonorsCsv(rows: readonly ClubHonorsRow[]) {
  const out: Array<Array<string | number>> = [[...CLUB_HONORS_CSV_HEADERS]];
  for (const row of rows) {
    const className = row.classLevel ? (clubClassLevelLabels[row.classLevel as keyof typeof clubClassLevelLabels] ?? row.classLevel) : "";
    if (row.honors.length === 0) {
      out.push([row.lastName, row.firstName, "", "", "", className]);
      continue;
    }
    for (const honor of row.honors) {
      out.push([row.lastName, row.firstName, honor.honorName, memberHonorStatusLabels[honor.status], honor.completionDate, className]);
    }
  }
  return toCsv(out);
}

/** The reason must be 3 to 500 characters once trimmed (#591). */
export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 500;

export type ClubHonorsEmptyState = "NO_MEMBERS" | "NO_MATCH" | "NO_HONORS";

/**
 * Which empty state the club Honors page shows (#701, D4), each with its own
 * copy: nobody on the roster, filters that exclude everyone, or members with
 * no honors recorded yet. `null` when there is something to show.
 */
export function clubHonorsEmptyState(allRows: readonly ClubHonorsRow[], visibleRows: readonly ClubHonorsRow[]): ClubHonorsEmptyState | null {
  if (allRows.length === 0) return "NO_MEMBERS";
  if (visibleRows.length === 0) return "NO_MATCH";
  if (allRows.every((row) => row.honors.length === 0)) return "NO_HONORS";
  return null;
}

export const clubHonorsEmptyCopy: Record<ClubHonorsEmptyState, string> = {
  NO_MEMBERS: "No members on the roster yet — add them on the Roster page first.",
  NO_HONORS: "No honors recorded yet. Tick the names above, then choose Record honor.",
  NO_MATCH: "No one matches these filters.",
};

/**
 * The body the bulk popup posts to the existing bulk-record endpoint (#819):
 * a date only goes with a completion. The server checks every field again.
 */
export function bulkHonorPayload(input: {
  memberIds: Iterable<string>;
  honorId: string;
  status: MemberHonorStatus;
  completionDate: string;
  note: string;
}) {
  return {
    memberIds: [...input.memberIds],
    honorId: input.honorId,
    status: input.status,
    completionDate: input.status === "COMPLETED" ? input.completionDate : "",
    note: input.note,
  };
}

/** The bulk button's label and, while it is disabled, the reason shown beside it (#701, D4). */
export function bulkHonorButtonState(selectedCount: number, honorChosen: boolean) {
  return {
    label: `Record honor for ${selectedCount} selected`,
    disabledReason: selectedCount === 0 ? "Tick at least one member." : !honorChosen ? "Choose an honor." : "",
  };
}

/**
 * The roster honors popup's mode (#701): it records only when the page said the
 * role may and the Honors list answered and did not report the caller
 * read-only. A failed Honors list is a load error, never a silent view-only.
 * The record endpoint checks access again either way.
 */
export function memberHonorsDialogMode(
  pageAllowsRecording: boolean,
  honorsList: { ok: boolean; readOnly: boolean } | null,
): "RECORD" | "VIEW_ONLY" | "LOAD_ERROR" {
  if (!pageAllowsRecording) return "VIEW_ONLY";
  if (!honorsList || !honorsList.ok) return "LOAD_ERROR";
  return honorsList.readOnly ? "VIEW_ONLY" : "RECORD";
}
