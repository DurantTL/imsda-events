import { calendarDateIn } from "@/modules/calendar/domain";
import {
  yearEndFields,
  type YearEndTotals,
  type ResolvedField,
} from "@/modules/club-reports/year-end-domain";
import { toCsv } from "@/modules/reporting/csv";

export type YearEndCsvClub = {
  name: string;
  church: string;
  status: "NONE" | "DRAFT" | "SUBMITTED";
  late: boolean;
  report: {
    contactName: string;
    contactWorkPhone: string;
    contactHomePhone: string;
    contactCellPhone: string;
    contactEmail: string;
    submittedAt: string | null;
    resolved: Record<string, ResolvedField>;
    totals: YearEndTotals;
  } | null;
};

const statusLabels = { NONE: "Not started", DRAFT: "Draft", SUBMITTED: "Submitted" } as const;

/**
 * One row per club, in the paper form's order (header, sections 1 to 11) with
 * its totals. Counts only: no young person's name, and no draft numbers (a
 * club's unsubmitted draft isn't shown as filed).
 */
export function yearEndReportCsv(clubs: readonly YearEndCsvClub[]) {
  const fieldColumns: Array<{ header: string; cell: (report: NonNullable<YearEndCsvClub["report"]>) => number }> = [];
  for (const field of yearEndFields) {
    fieldColumns.push({ header: field.label, cell: (report) => report.resolved[field.key]?.value ?? 0 });
    if (field.section === "membership" && field.key.endsWith("Female1112")) {
      fieldColumns.push({ header: "Membership total", cell: (report) => report.totals.membership });
    }
    if (field.key === "staffFemale") {
      fieldColumns.push({ header: "Staff total", cell: (report) => report.totals.staff });
      fieldColumns.push({ header: "Total membership", cell: (report) => report.totals.totalMembership });
    }
    if (field.key === "tltFemale34") fieldColumns.push({ header: "TLTs total", cell: (report) => report.totals.tlts });
    if (field.key === "baptismTeen") fieldColumns.push({ header: "Youth baptisms total", cell: (report) => report.totals.youthBaptisms });
    if (field.key === "investedMASTER_GUIDE") fieldColumns.push({ header: "Invested total", cell: (report) => report.totals.invested });
  }
  const rows: Array<Array<string | number>> = [[
    "Club", "Sponsoring church", "Status", "Submitted on", "Late",
    "Name", "Work phone", "Home phone", "Cell phone", "Email",
    ...fieldColumns.map((column) => column.header),
  ]];
  for (const club of clubs) {
    const report = club.report;
    rows.push([
      club.name,
      club.church,
      statusLabels[club.status],
      report?.submittedAt ? calendarDateIn(new Date(report.submittedAt)) : "",
      club.status === "SUBMITTED" ? (club.late ? "Yes" : "No") : "",
      report?.contactName ?? "",
      report?.contactWorkPhone ?? "",
      report?.contactHomePhone ?? "",
      report?.contactCellPhone ?? "",
      report?.contactEmail ?? "",
      ...fieldColumns.map((column) => (report ? column.cell(report) : "")),
    ]);
  }
  return toCsv(rows);
}
