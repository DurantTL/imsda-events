import { clubYearMonths, isLockedForClub, reportMonthLabel, yearToDate } from "@/modules/club-reports/domain";
import { toCsv } from "@/modules/reporting/csv";

type ClubYearRow = {
  name: string;
  church: string;
  registrationOnTime: boolean;
  reports: Record<string, { totalPoints: number; onTime: boolean }>;
};

/** One row per club: points per month ("missing" once a month is past due), registration, and year to date. */
export function clubYearReportCsv(clubYear: string, clubs: readonly ClubYearRow[], now: Date) {
  const months = clubYearMonths(clubYear);
  const rows: Array<Array<string | number>> = [[
    "Club", "Sponsoring church", ...months.map(reportMonthLabel), "Yearly registration", "Reports missing", "Year to date",
  ]];
  for (const club of clubs) {
    const cells = months.map((month) => {
      const report = club.reports[month];
      if (report) return report.totalPoints;
      return isLockedForClub(month, now) ? "missing" : "";
    });
    rows.push([
      club.name,
      club.church,
      ...cells,
      club.registrationOnTime ? 1500 : 0,
      cells.filter((cell) => cell === "missing").length,
      yearToDate(Object.values(club.reports), club.registrationOnTime),
    ]);
  }
  return toCsv(rows);
}
