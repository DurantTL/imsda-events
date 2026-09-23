import { calendarDateIn } from "@/modules/calendar/domain";
import { CLUB_YEAR_START_MONTH, type ClubClassLevel } from "@/modules/club-rosters/domain";

/**
 * Club monthly reports (#377), replacing the old website's "Pathfinder
 * Monthly Report" (Fluent Forms 114). One report per club per month, due the
 * 10th of the next month in conference time. Every item is picked by the
 * club from the values the old form offered, except "submitted by the 10th",
 * which is worked out from when the report was first submitted.
 */

export type PointItemKey =
  | "staffMeeting"
  | "meetingsOutings"
  | "ratio"
  | "uniformMeetings"
  | "uniformOutside"
  | "devotions"
  | "exercise"
  | "outreach"
  | "guest"
  | "honors"
  | "classLevel"
  | "bonus";

export type PointItem = { key: PointItemKey; label: string; help: string; values: readonly number[] };

export const ON_TIME_POINTS = 25;
export const YEARLY_REGISTRATION_POINTS = 1500;
export const REPORT_DUE_DAY = 10;
export const MAX_HONORS = 3;

export const pointItems: readonly PointItem[] = [
  { key: "staffMeeting", label: "Monthly staff meeting", help: "At least one this month.", values: [25, 0] },
  { key: "meetingsOutings", label: "Meetings and outings", help: "25 points each, up to 125.", values: [0, 25, 50, 75, 100, 125] },
  { key: "ratio", label: "Kept a 10:1 Pathfinder-to-staff ratio", help: "", values: [25, 0] },
  { key: "uniformMeetings", label: "Field uniform at meetings", help: "100% = 25, 80% = 20, 60% = 10.", values: [25, 20, 10, 0] },
  { key: "uniformOutside", label: "Class A or field uniform outside meetings", help: "100% = 50, 80% = 40, 60% = 30.", values: [50, 40, 30, 0] },
  { key: "devotions", label: "Daily devotions and devotional time at each meeting", help: "", values: [50, 0] },
  { key: "exercise", label: "Promoted daily exercise", help: "", values: [50, 0] },
  { key: "outreach", label: "Community outreach or hosted a local church service", help: "", values: [50, 0] },
  { key: "guest", label: "Guest teacher, observer, or helper", help: "", values: [50, 0] },
  { key: "honors", label: "Honors worked on", help: "25 points per honor, up to 3. List them below.", values: [0, 25, 50, 75] },
  { key: "classLevel", label: "Class level worked on", help: "Choose the class levels below.", values: [25, 0] },
  { key: "bonus", label: "Bonus: health-temperance event or Pathfinder Evangelism Award", help: "", values: [50, 0] },
];

export type PickedPoints = Partial<Record<PointItemKey, number>>;
export type ReportHonor = { name: string; participants: number | null };

/** The most a month can earn: every item at its top value, plus on time. */
export const MAX_MONTHLY_POINTS = ON_TIME_POINTS + pointItems.reduce((sum, item) => sum + Math.max(...item.values), 0);

/** Problems that stop a report from saving. Each names the item, so the form can show it there. */
export function reportProblems(input: { points: PickedPoints; honors: readonly ReportHonor[]; classLevels: readonly ClubClassLevel[] }) {
  const problems: Array<{ key: PointItemKey | "honorsList"; message: string }> = [];
  for (const item of pointItems) {
    const value = input.points[item.key];
    if (value === undefined) continue;
    if (!item.values.includes(value)) {
      problems.push({ key: item.key, message: `${item.label}: ${value} isn't allowed. Choose ${item.values.join(", ")}.` });
    }
  }
  const namedHonors = input.honors.filter((honor) => honor.name.trim()).length;
  if (input.honors.length > MAX_HONORS) problems.push({ key: "honorsList", message: `List at most ${MAX_HONORS} honors.` });
  if ((input.points.honors ?? 0) > namedHonors * 25) {
    problems.push({
      key: "honors",
      message: `Honors worked on: ${input.points.honors} points needs ${(input.points.honors ?? 0) / 25} honors listed, but ${namedHonors === 1 ? "1 is" : `${namedHonors} are`} listed.`,
    });
  }
  if ((input.points.classLevel ?? 0) > 0 && input.classLevels.length === 0) {
    problems.push({ key: "classLevel", message: "Class level worked on: choose at least one class level, or pick 0." });
  }
  return problems;
}

export function pickedTotal(points: PickedPoints) {
  return pointItems.reduce((sum, item) => sum + (points[item.key] ?? 0), 0);
}

/** "2026-10" → "2026-11-10": the last day a report counts as on time, in conference time. */
export function reportDueDate(reportMonth: string) {
  const [year, month] = reportMonth.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(REPORT_DUE_DAY).padStart(2, "0")}`;
}

export function isOnTime(reportMonth: string, firstSubmittedAt: Date) {
  return calendarDateIn(firstSubmittedAt) <= reportDueDate(reportMonth);
}

export function onTimePoints(reportMonth: string, firstSubmittedAt: Date) {
  return isOnTime(reportMonth, firstSubmittedAt) ? ON_TIME_POINTS : 0;
}

/** After the due date only conference staff may change a report. */
export function isLockedForClub(reportMonth: string, now: Date) {
  return calendarDateIn(now) > reportDueDate(reportMonth);
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isReportMonth(value: string) {
  return MONTH.test(value);
}

/** The twelve months of a club year, September first: "2026-27" → ["2026-09", …, "2027-08"]. */
export function clubYearMonths(clubYear: string) {
  const start = Number(clubYear.slice(0, 4));
  return Array.from({ length: 12 }, (_, index) => {
    const month = ((CLUB_YEAR_START_MONTH - 1 + index) % 12) + 1;
    const year = month >= CLUB_YEAR_START_MONTH ? start : start + 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

/** Months of the club year a club can report on now: through the current month. */
export function reportableMonths(clubYear: string, now: Date) {
  const current = calendarDateIn(now).slice(0, 7);
  return clubYearMonths(clubYear).filter((month) => month <= current);
}

export function reportMonthLabel(reportMonth: string) {
  const [year, month] = reportMonth.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function formatDueDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Year-to-date points: every report's total, plus the yearly registration when it was on time. */
export function yearToDate(reports: ReadonlyArray<{ totalPoints: number }>, registrationOnTime: boolean) {
  return reports.reduce((sum, report) => sum + report.totalPoints, 0) + (registrationOnTime ? YEARLY_REGISTRATION_POINTS : 0);
}
