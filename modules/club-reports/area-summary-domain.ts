import { clubYearMonths, isLockedForClub, reportMonthLabel, yearToDate } from "@/modules/club-reports/domain";
import { calendarDateIn } from "@/modules/calendar/domain";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Cross-club monthly report summary for Area Coordinators and the conference
 * office. Pure functions over already-loaded rows: counts and points only.
 * Background checks are counts, never names or notes (#479).
 */

export type MonthStatus = "SUBMITTED" | "LATE" | "DRAFT" | "MISSING" | "DUE" | "FUTURE";

export const monthStatusLabels: Record<MonthStatus, string> = {
  SUBMITTED: "Submitted",
  LATE: "Late",
  DRAFT: "Draft",
  MISSING: "Missing",
  DUE: "Due",
  FUTURE: "Not yet due",
};

export type MonthCell = { month: string; status: MonthStatus; points: number | null };

export type AreaSummaryInput = {
  id: string;
  name: string;
  church: string;
  directors: string[];
  rosterSize: number;
  registrationOnTime: boolean;
  backgroundChecks: { missing: number; notInCompliance: number; expiringSoon: number };
  reports: ReadonlyArray<{ reportMonth: string; status: "DRAFT" | "SUBMITTED"; totalPoints: number; onTimePoints: number }>;
};

export type AreaClubSummary = {
  id: string;
  name: string;
  church: string;
  directors: string[];
  rosterSize: number;
  registrationOnTime: boolean;
  backgroundChecks: AreaSummaryInput["backgroundChecks"];
  months: MonthCell[];
  submitted: number;
  late: number;
  drafts: number;
  missing: number;
  lastReportMonth: string | null;
  reportPoints: number;
  totalPoints: number;
};

/** One month's status for one club. Only submitted reports earn points. */
export function monthCell(
  month: string,
  report: AreaSummaryInput["reports"][number] | undefined,
  now: Date,
): MonthCell {
  if (report?.status === "SUBMITTED") {
    return { month, status: report.onTimePoints > 0 ? "SUBMITTED" : "LATE", points: report.totalPoints };
  }
  if (report?.status === "DRAFT") return { month, status: "DRAFT", points: null };
  if (month > calendarDateIn(now).slice(0, 7)) return { month, status: "FUTURE", points: null };
  return { month, status: isLockedForClub(month, now) ? "MISSING" : "DUE", points: null };
}

export function summarizeClub(input: AreaSummaryInput, clubYear: string, now: Date): AreaClubSummary {
  const byMonth = new Map(input.reports.map((report) => [report.reportMonth, report]));
  const months = clubYearMonths(clubYear).map((month) => monthCell(month, byMonth.get(month), now));
  const submittedReports = input.reports.filter((report) => report.status === "SUBMITTED");
  const submittedMonths = months.filter((cell) => cell.status === "SUBMITTED" || cell.status === "LATE");
  return {
    id: input.id,
    name: input.name,
    church: input.church,
    directors: input.directors,
    rosterSize: input.rosterSize,
    registrationOnTime: input.registrationOnTime,
    backgroundChecks: input.backgroundChecks,
    months,
    submitted: submittedMonths.length,
    late: months.filter((cell) => cell.status === "LATE").length,
    drafts: months.filter((cell) => cell.status === "DRAFT").length,
    missing: months.filter((cell) => cell.status === "MISSING").length,
    lastReportMonth: submittedMonths.length > 0 ? submittedMonths[submittedMonths.length - 1]!.month : null,
    reportPoints: submittedReports.reduce((sum, report) => sum + report.totalPoints, 0),
    // The same figure the club's own overview shows: reports plus the on-time yearly registration.
    totalPoints: yearToDate(submittedReports, input.registrationOnTime),
  };
}

export type LeaderboardSort = "points" | "name";

export function parseLeaderboardSort(value: string | undefined): LeaderboardSort {
  return value === "name" ? "name" : "points";
}

/** Highest points first (ties by name), or by name. Never mutates the input. */
export function sortLeaderboard<T extends { name: string; totalPoints: number }>(clubs: readonly T[], sort: LeaderboardSort) {
  return [...clubs].sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name) : b.totalPoints - a.totalPoints || a.name.localeCompare(b.name));
}

/** The club-name search the area-coordinator tabs share (#791): the text typed, trimmed and capped. */
export function parseClubQuery(value: string | string[] | undefined) {
  const text = Array.isArray(value) ? value[0] : value;
  return (text ?? "").trim().slice(0, 80);
}

const normalizeName = (value: string) => value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();

/** Keeps clubs whose name contains the search text, ignoring case and extra spaces. Blank keeps all. Never mutates the input. */
export function filterClubsByName<T extends { name: string }>(clubs: readonly T[], query: string | undefined) {
  const needle = normalizeName(query ?? "");
  return needle === "" ? [...clubs] : clubs.filter((club) => normalizeName(club.name).includes(needle));
}

/** Plain-language description of a chart, for screen readers. */
export function pointsChartDescription(clubs: ReadonlyArray<{ name: string; totalPoints: number }>, clubYear: string) {
  if (clubs.length === 0) return `No active clubs for ${clubYear}.`;
  const top = clubs.reduce((best, club) => (club.totalPoints > best.totalPoints ? club : best), clubs[0]!);
  return `Bar chart of club year ${clubYear} total points for ${clubs.length} ${clubs.length === 1 ? "club" : "clubs"}. `
    + `Highest: ${top.name} with ${top.totalPoints.toLocaleString("en-US")} points. The same numbers are in the table below.`;
}

function cellText(cell: MonthCell) {
  if (cell.status === "LATE") return `${cell.points} (late)`;
  if (cell.points !== null) return String(cell.points);
  return cell.status === "MISSING" || cell.status === "DRAFT" || cell.status === "DUE" ? monthStatusLabels[cell.status].toLowerCase() : "";
}

/** The monthly summary table: points or status for each month, then club-year totals. */
export function areaSummaryCsv(clubYear: string, clubs: readonly AreaClubSummary[]) {
  const months = clubYearMonths(clubYear);
  const rows: Array<Array<string | number>> = [[
    "Club", "Sponsoring church", ...months.map(reportMonthLabel),
    "Submitted", "Late", "Draft", "Missing", "Report points", "Yearly registration points", "Total points",
  ]];
  for (const club of clubs) {
    rows.push([
      club.name, club.church,
      ...club.months.map(cellText),
      club.submitted, club.late, club.drafts, club.missing,
      club.reportPoints, club.totalPoints - club.reportPoints, club.totalPoints,
    ]);
  }
  return toCsv(rows);
}

/** The points leaderboard: one row per club, highest first. */
export function areaPointsCsv(clubYear: string, clubs: readonly AreaClubSummary[]) {
  const rows: Array<Array<string | number>> = [["Rank", "Club", "Sponsoring church", "Club year", "Report points", "Yearly registration points", "Total points"]];
  sortLeaderboard(clubs, "points").forEach((club, index) => {
    rows.push([index + 1, club.name, club.church, clubYear, club.reportPoints, club.totalPoints - club.reportPoints, club.totalPoints]);
  });
  return toCsv(rows);
}

export type AreaEventClubRow = {
  organizationId: string;
  name: string;
  status: "NOT_REGISTERED" | "REGISTERED" | "WAITLISTED" | "CANCELLED" | "DRAFT";
  headcount: number | null;
};

export const eventStatusLabels: Record<AreaEventClubRow["status"], string> = {
  NOT_REGISTERED: "Not registered",
  DRAFT: "Draft",
  REGISTERED: "Registered",
  WAITLISTED: "Waitlisted",
  CANCELLED: "Cancelled",
};

/** Headcount across registered clubs only (waitlisted and cancelled clubs don't count). */
export function eventHeadcount(rows: readonly AreaEventClubRow[]) {
  return rows.reduce((sum, row) => sum + (row.status === "REGISTERED" ? row.headcount ?? 0 : 0), 0);
}

export function registrationStatusFor(status: string | null | undefined): AreaEventClubRow["status"] {
  if (!status) return "NOT_REGISTERED";
  if (status === "SUBMITTED" || status === "CONFIRMED") return "REGISTERED";
  if (status === "WAITLISTED") return "WAITLISTED";
  if (status === "CANCELLED") return "CANCELLED";
  return "DRAFT";
}
