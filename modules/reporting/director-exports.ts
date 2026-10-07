import { toCsv } from "@/modules/reporting/csv";

/**
 * Director exports for honors and class tracking (#655). Pure: the repository
 * gathers the rows, this file shapes them into CSV and printable summaries.
 * Names, class, honors and earned items only: never a birth date, age,
 * contact or health field. Every CSV cell goes through `toCsv` (formula-safe).
 */

export type ExportContext = { clubName: string; clubYear: string };

// ---------------------------------------------------------------- honors

export type HonorsExportRow = {
  memberId: string;
  honorId: string;
  lastName: string;
  firstName: string;
  /** Class label, or "" when the roster has none. */
  className: string;
  honorName: string;
  /** Honor category label, or "". */
  category: string;
  /** "Completed" or "In progress". */
  status: string;
  /** Completion date (YYYY-MM-DD) when completed, otherwise the date it was recorded. */
  dateEarned: string;
  /** Says which date the column holds. */
  dateKind: "Completed" | "Recorded";
  /** The event where it was earned, when known (a weekend honors class). */
  eventName: string;
};

export type HonorsSummaryRow = { honorId: string; honorName: string; category: string; count: number };

/** Completed honors per honor name, most first then by name. */
export function honorsSummary(rows: readonly HonorsExportRow[]): HonorsSummaryRow[] {
  const counts = new Map<string, HonorsSummaryRow>();
  for (const row of rows) {
    if (row.status !== "Completed") continue;
    const entry = counts.get(row.honorId) ?? { honorId: row.honorId, honorName: row.honorName, category: row.category, count: 0 };
    entry.count += 1;
    counts.set(row.honorId, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.honorName.localeCompare(b.honorName));
}

/**
 * The club-wide print report (#819): each completed honor with how many members
 * completed it. The result type has no name or date field, so nothing about a
 * person can reach the printed page through it.
 */
export type ClubHonorCount = { honorName: string; count: number };

export function clubHonorCounts(rows: readonly HonorsExportRow[]): ClubHonorCount[] {
  return honorsSummary(rows).map(({ honorName, count }) => ({ honorName, count }));
}

/** The one-person print report (#819): that member's completed honors, A to Z, with the completion date when one is on file. */
export type MemberCompletedHonor = { honorName: string; completionDate: string };

export function memberCompletedHonors(rows: readonly HonorsExportRow[]): MemberCompletedHonor[] {
  return rows
    .filter((row) => row.status === "Completed")
    .map((row) => ({ honorName: row.honorName, completionDate: row.dateKind === "Completed" ? row.dateEarned : "" }))
    .sort((a, b) => a.honorName.localeCompare(b.honorName));
}

export const HONORS_EXPORT_HEADERS = [
  "Last name", "First name", "Class", "Honor", "Category", "Status", "Date earned or recorded", "Date type", "Event where earned",
] as const;

export function honorsExportCsv(context: ExportContext, rows: readonly HonorsExportRow[]) {
  const out: Array<Array<string | number>> = [
    ["Club", context.clubName],
    ["Club year", context.clubYear],
    ["Report", "Honors"],
    [],
    [...HONORS_EXPORT_HEADERS],
  ];
  if (rows.length === 0) out.push(["No honors recorded for the chosen filters."]);
  for (const row of rows) {
    out.push([row.lastName, row.firstName, row.className, row.honorName, row.category, row.status, row.dateEarned, row.dateKind, row.eventName]);
  }
  out.push([], ["Summary: completed honors", "Count"]);
  const summary = honorsSummary(rows);
  if (summary.length === 0) out.push(["No completed honors."]);
  for (const entry of summary) out.push([entry.honorName, entry.count]);
  return toCsv(out);
}

// ---------------------------------------------------------------- class tracking

export type ClassTrackingMemberRow = {
  personId: string;
  lastName: string;
  firstName: string;
  className: string;
  /** Class insignia items earned (open or awarded), by item name. */
  insignia: string[];
  eventPatches: string[];
  /** Good Conduct, TLT and anything else added by hand. */
  conductAndTlt: string[];
  /** One line per Master Award the member is working toward, eligible for, or has on order. */
  masterAwards: string[];
};

export const CLASS_TRACKING_EXPORT_HEADERS = [
  "Last name", "First name", "Current class", "Class insignia", "Event patches", "Good Conduct / TLT / other items", "Master Award progress",
] as const;

const join = (values: readonly string[]) => values.join("; ");

export function classTrackingExportCsv(context: ExportContext, rows: readonly ClassTrackingMemberRow[]) {
  const out: Array<Array<string | number>> = [
    ["Club", context.clubName],
    ["Club year", context.clubYear],
    ["Report", "Class tracking"],
    [],
    [...CLASS_TRACKING_EXPORT_HEADERS],
  ];
  if (rows.length === 0) out.push(["No active roster members for this club year."]);
  for (const row of rows) {
    out.push([
      row.lastName, row.firstName, row.className,
      join(row.insignia), join(row.eventPatches), join(row.conductAndTlt), join(row.masterAwards),
    ]);
  }
  return toCsv(out);
}

export function exportFileName(report: "honors" | "class-tracking", clubYear: string) {
  return `club-${report}-${clubYear}.csv`;
}
