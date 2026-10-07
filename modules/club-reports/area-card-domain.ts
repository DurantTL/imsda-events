import { monthCell } from "@/modules/club-reports/area-summary-domain";
import { clubYearMonths } from "@/modules/club-reports/domain";
import { calendarDateIn } from "@/modules/calendar/domain";

/**
 * The Area Coordinator's home card (#656): pure helpers over already-loaded
 * rows. Counts only for clubs needing attention, never a name or a note (#479).
 */

export type AreaCardLink = { href: string; label: string };

/** Quick links on the card. The health view (#658) is gated again on its own page. */
export function areaCardLinks(): AreaCardLink[] {
  return [
    { href: "/account/area-clubs/overview", label: "Clubs overview" },
    { href: "/account/area-clubs/events", label: "Club event registrations" },
    { href: "/account/area/health", label: "Event health information" },
  ];
}

export type RegistrationWindow = { label: string; open: boolean };

/** Open/closed wording from the event's (or location's) `YYYY-MM-DD` window, compared in the conference time zone. */
export function registrationWindow(
  opensOn: string | null,
  closesOn: string | null,
  now: Date,
): RegistrationWindow {
  const today = calendarDateIn(now);
  if (opensOn && today < opensOn) return { label: `Opens ${opensOn}`, open: false };
  if (closesOn && today > closesOn) return { label: "Closed", open: false };
  return { label: closesOn ? `Open, closes ${closesOn}` : "Open", open: true };
}

export type ClubChecks = { missing: number; notInCompliance: number; expiringSoon: number };
export type ClubReportRow = {
  organizationId: string;
  reportMonth: string;
  status: "DRAFT" | "SUBMITTED";
  totalPoints: number;
  onTimePoints: number;
};

/**
 * Counts of clubs with a past-due monthly report (a month neither filed nor a
 * draft once its due date passed, the same rule as the overview's "Missing"),
 * and of clubs with any Sterling Volunteers reminder. Counts only, never a name.
 */
export function clubsNeedingAttention(input: {
  clubIds: readonly string[];
  clubYear: string;
  now: Date;
  reports: readonly ClubReportRow[];
  checks: ReadonlyMap<string, ClubChecks>;
}) {
  const months = clubYearMonths(input.clubYear);
  let overdueReports = 0;
  let backgroundCheckReminders = 0;
  let either = 0;
  for (const id of input.clubIds) {
    const byMonth = new Map(input.reports.filter((report) => report.organizationId === id).map((report) => [report.reportMonth, report]));
    const overdue = months.some((month) => monthCell(month, byMonth.get(month), input.now).status === "MISSING");
    const checks = input.checks.get(id);
    const reminder = Boolean(checks && checks.missing + checks.notInCompliance + checks.expiringSoon > 0);
    if (overdue) overdueReports += 1;
    if (reminder) backgroundCheckReminders += 1;
    if (overdue || reminder) either += 1;
  }
  return { overdueReports, backgroundCheckReminders, either };
}
