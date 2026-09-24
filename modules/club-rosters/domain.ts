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

/** Pathfinder class levels (#375), in the order a Pathfinder moves through them. */
export const clubClassLevelLabels = {
  FRIEND: "Friend",
  COMPANION: "Companion",
  EXPLORER: "Explorer",
  RANGER: "Ranger",
  VOYAGER: "Voyager",
  GUIDE: "Guide",
  TLT: "TLT",
  MASTER_GUIDE: "Master Guide",
} as const;

export type ClubClassLevel = keyof typeof clubClassLevelLabels;

export const clubClassLevels = Object.keys(clubClassLevelLabels) as ClubClassLevel[];

/** The roster screen's two lists (#375): staff and adults, and the club's members. */
export type RosterSection = "STAFF" | "MEMBERS";

export function rosterSectionOf(attendeeType: keyof typeof clubRosterAttendeeTypeLabels): RosterSection {
  return attendeeType === "STAFF" || attendeeType === "ADULT" ? "STAFF" : "MEMBERS";
}

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

/**
 * Two-digit years (#424): "26" or earlier — this year's own last two digits —
 * is 20YY, otherwise 19YY. In 2026, `14` is 2014 and `68` is 1968.
 */
export function centuryForTwoDigitYear(twoDigit: number, currentYear: number) {
  return twoDigit <= currentYear % 100 ? 2000 + twoDigit : 1900 + twoDigit;
}

/**
 * A birth date typed as `M/D/YYYY` or `M/D/YY`, or already `YYYY-MM-DD`, into
 * `YYYY-MM-DD` (#424). One shared, pure parser for the roster form and the
 * CSV import, with the current year injectable for tests. Two-digit years
 * follow the century rule above. Returns null for anything that isn't a real
 * calendar date (`02/30/2014`) or a year before 1900; it doesn't check
 * whether the date is in the future or implausibly old — use
 * `birthDateProblem` for that. Pass `allowTwoDigitYear: false` for dates
 * that aren't birth dates (a background check's expiration, say), where the
 * century rule would misread `6/30/28` as 1928: `M/D/YY` is then rejected.
 */
export function parseRosterBirthDateInput(
  value: string,
  currentYear = new Date().getFullYear(),
  options: { allowTwoDigitYear?: boolean } = {},
): string | null {
  const { allowTwoDigitYear = true } = options;
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  const us = allowTwoDigitYear
    ? /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed)
    : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = us[3].length === 2 ? centuryForTwoDigitYear(Number(us[3]), currentYear) : Number(us[3]);
  } else {
    return null;
  }
  if (year < 1900) return null;
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return parseCalendarDate(isoDate) ? isoDate : null;
}

/**
 * The role a blank Role field saves as (#424): "Pathfinder" for youth, and
 * nothing for staff and adults, whose rows then fall back to their type label
 * as before. A role someone typed is never replaced.
 */
export function defaultRosterRole(attendeeType: string | null | undefined) {
  return attendeeType === "YOUTH" ? "Pathfinder" : "";
}

/** A typed role, or the default for the type when it was left blank (#424). */
export function rosterRoleOrDefault(role: string | null | undefined, attendeeType: string | null | undefined) {
  const typed = (role ?? "").trim();
  return typed || defaultRosterRole(attendeeType);
}

/** The roster's own fields, for the "Missing info" flag (#424). */
export const rosterFieldLabels = {
  birthDate: "Birth date",
  gender: "Gender",
  classLevel: "Current class",
  role: "Role",
  attendeeType: "Type",
} as const;

type MissingFieldMember = {
  attendeeType: string | null | undefined;
  role: string | null | undefined;
  classLevel: string | null | undefined;
  gender: string | null | undefined;
  /** Whether a sealed birth date exists, without opening it. */
  birthDateNeeded: boolean;
};

/**
 * What a roster member is missing among the fields the roster collects
 * (#424): birth date, gender, current class (youth only), role, and type. Pure; worked
 * out from the record alone, so it needs no schema change and never opens a
 * sealed birth date.
 */
export function missingRosterFields(member: MissingFieldMember): string[] {
  const missing: string[] = [];
  if (member.birthDateNeeded) missing.push(rosterFieldLabels.birthDate);
  if (!member.gender) missing.push(rosterFieldLabels.gender);
  // Only youth are in a class; staff and adults are usually "None" (#424).
  if (member.attendeeType === "YOUTH" && !member.classLevel) missing.push(rosterFieldLabels.classLevel);
  // A blank role only matters for youth; staff and adults show their type.
  if (member.attendeeType === "YOUTH" && !member.role) missing.push(rosterFieldLabels.role);
  if (!member.attendeeType) missing.push(rosterFieldLabels.attendeeType);
  return missing;
}
