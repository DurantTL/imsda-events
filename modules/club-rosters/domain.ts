/**
 * Club rosters (#356). Pure rules: club years, ages, and labels. Birth dates
 * travel as `YYYY-MM-DD` calendar dates, never as instants, so a time zone can
 * never move someone's birthday.
 */

export const clubRosterAttendeeTypeLabels = {
  YOUTH: "Youth",
  STAFF: "Staff",
  ADULT: "Adult",
  UNDERAGE: "Underage",
} as const;

export const clubRosterGenderLabels = { FEMALE: "Female", MALE: "Male" } as const;

export const clubRosterStatusLabels = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  REMOVED: "Removed",
} as const;

/** Club years run September through August, e.g. "2026-27". */
export const CLUB_YEAR_START_MONTH = 9;

export function clubYearFor(date: Date) {
  const year = date.getUTCFullYear();
  const start = date.getUTCMonth() + 1 >= CLUB_YEAR_START_MONTH ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDate(value: string) {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** Whole years of age on `onDate` (a calendar date). A Feb 29 birthday turns over on Mar 1. */
export function ageOn(birthDate: string, onDate: string) {
  const birth = parseCalendarDate(birthDate);
  const on = parseCalendarDate(onDate);
  if (!birth || !on) return null;
  let age = on.year - birth.year;
  if (on.month < birth.month || (on.month === birth.month && on.day < birth.day)) age -= 1;
  return age;
}

export function calendarDateOf(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** A birth date the roster accepts: a real date, not in the future, under 120 years ago. */
export function birthDateProblem(birthDate: string, today: string) {
  if (!parseCalendarDate(birthDate)) return "Enter a real birth date.";
  if (birthDate > today) return "A birth date can't be in the future.";
  const age = ageOn(birthDate, today);
  if (age === null || age > 120) return "Check the birth date year.";
  return null;
}
