import { calendarDateIn } from "@/modules/calendar/domain";

/**
 * The Pathfinder Year-End Report (#607), replacing the paper/Word form. One
 * report per club per Pathfinder year, May 1 to April 30, labelled by its
 * start year ("2026-27" = May 1 2026 to April 30 2027) and due April 1 (the
 * paper form's date). Counts only: no young person's name is ever held here.
 *
 * Every field is either pre-filled from platform data (the director may
 * override it; the original number is kept) or manual (the platform holds no
 * such data). Totals are always worked out here, never typed or stored.
 */

export const YEAR_END_START_MONTH = 5;
export const YEAR_END_DUE_MONTH = 4;
export const YEAR_END_DUE_DAY = 1;

const YEAR_LABEL = /^(\d{4})-(\d{2})$/;

export function isReportYear(value: string) {
  const match = YEAR_LABEL.exec(value);
  if (!match) return false;
  const start = Number(match[1]);
  return Number(match[2]) === (start + 1) % 100 && start >= 2000 && start <= 2100;
}

export function reportYearLabel(startYear: number) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** "2026-27" -> 2026 */
export function reportYearStart(reportYear: string) {
  return Number(reportYear.slice(0, 4));
}

/** The May 1 to April 30 span, as calendar dates, plus the April 1 due date. */
export function reportYearRange(reportYear: string) {
  const start = reportYearStart(reportYear);
  return { start: `${start}-05-01`, end: `${start + 1}-04-30`, dueDate: reportYearDueDate(reportYear) };
}

export function reportYearDueDate(reportYear: string) {
  return `${reportYearStart(reportYear) + 1}-04-01`;
}

/** The newest Pathfinder year that has begun (May 1 or later) in conference time. */
export function latestStartedReportYear(now: Date) {
  const today = calendarDateIn(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return reportYearLabel(month >= YEAR_END_START_MONTH ? year : year - 1);
}

/** The years a club may view and save: the newest started year and the one before it, newest first. */
export function reportableReportYears(now: Date) {
  const latest = reportYearStart(latestStartedReportYear(now));
  return [reportYearLabel(latest), reportYearLabel(latest - 1)];
}

/** Whether a club may save this year's report right now: only the current and previous Pathfinder year. */
export function isReportYearReportable(reportYear: string, now: Date) {
  return isReportYear(reportYear) && reportableReportYears(now).includes(reportYear);
}

/** The first instant of the year (May 1, midnight Central daylight time), for comparing roster timestamps. */
export function reportYearStartInstant(reportYear: string) {
  return new Date(Date.UTC(reportYearStart(reportYear), YEAR_END_START_MONTH - 1, 1, 5, 0, 0));
}

/** Whether `date` (a calendar date) falls inside the Pathfinder year, inclusive. */
export function isInReportYear(date: string, reportYear: string) {
  const { start, end } = reportYearRange(reportYear);
  return date >= start && date <= end;
}

/** The date ages are worked out on: the year's last day, or today while the year is still running. */
export function ageReferenceDate(reportYear: string, now: Date) {
  const today = calendarDateIn(now);
  const { end } = reportYearRange(reportYear);
  return today < end ? today : end;
}

export function isPastDue(reportYear: string, now: Date) {
  return calendarDateIn(now) > reportYearDueDate(reportYear);
}

/** Once submitted, a report is closed to the club. Only staff can reopen it. */
export function isYearEndLockedForClub(status: "DRAFT" | "SUBMITTED") {
  return status === "SUBMITTED";
}

/** Filed after the April 1 due date (judged on the first time it reached SUBMITTED, in conference time). */
export function isLateYearEndReport(reportYear: string, firstSubmittedAt: Date) {
  return calendarDateIn(firstSubmittedAt) > reportYearDueDate(reportYear);
}

// ---------------------------------------------------------------------------
// Fields

export const advancedClasses = [
  { level: "FRIEND", label: "Friend", advancedLabel: "Trail Friend" },
  { level: "COMPANION", label: "Companion", advancedLabel: "Trail Companion" },
  { level: "EXPLORER", label: "Explorer", advancedLabel: "Wilderness Explorer" },
  { level: "RANGER", label: "Ranger", advancedLabel: "Wilderness Ranger" },
  { level: "VOYAGER", label: "Voyager", advancedLabel: "Frontier Voyager" },
  { level: "GUIDE", label: "Guide", advancedLabel: "Frontier Guide" },
] as const;

export type InvestitureClassLevel = (typeof advancedClasses)[number]["level"] | "MASTER_GUIDE";

export type YearEndSection =
  | "membership"
  | "staff"
  | "tlts"
  | "youthBaptisms"
  | "adultBaptisms"
  | "invested"
  | "honors"
  | "honorMasters"
  | "leadershipAward"
  | "instructorAward";

export type YearEndField = {
  key: string;
  section: YearEndSection;
  /** Column heading on the paper form / CSV. */
  label: string;
  /** "prefill": worked out from platform data, overridable. "manual": typed in. */
  source: "prefill" | "manual";
  /** For pre-filled fields: what the number comes from, shown as "from your roster". */
  origin?: "roster-age" | "roster" | "class-completions" | "honors";
};

const bands = [
  { id: "57", label: "Grades 5-7" },
  { id: "810", label: "Grades 8-10" },
  { id: "1112", label: "Grades 11-12" },
] as const;

export type GradeBand = (typeof bands)[number]["id"];

const genders = [
  { id: "Male", label: "Male" },
  { id: "Female", label: "Female" },
] as const;

const tltBands = [
  { id: "12", label: "Levels 1 & 2" },
  { id: "34", label: "Levels 3 & 4" },
] as const;

const baptismBands = [
  { id: "Junior", label: "Junior (grades 5-7, ages 10-12)" },
  { id: "Earliteen", label: "Earliteen (grades 8-10, ages 13-15)" },
  { id: "Teen", label: "Teen (grades 11-12, ages 16-18)" },
] as const;

export const yearEndFields: readonly YearEndField[] = [
  ...bands.flatMap((band) => genders.map((gender): YearEndField => ({
    key: `member${gender.id}${band.id}`,
    section: "membership",
    label: `Membership ${gender.label}, ${band.label}`,
    source: "prefill",
    origin: "roster-age",
  }))),
  ...genders.map((gender): YearEndField => ({
    key: `staff${gender.id}`, section: "staff", label: `Staff ${gender.label}`, source: "prefill", origin: "roster",
  })),
  ...tltBands.flatMap((band) => genders.map((gender): YearEndField => ({
    key: `tlt${gender.id}${band.id}`, section: "tlts", label: `TLTs ${gender.label}, ${band.label}`, source: "manual",
  }))),
  ...baptismBands.map((band): YearEndField => ({
    key: `baptism${band.id}`, section: "youthBaptisms", label: `Youth baptisms: ${band.label}`, source: "manual",
  })),
  { key: "baptismAdult", section: "adultBaptisms", label: "Adult baptisms", source: "manual" },
  ...advancedClasses.flatMap((item): YearEndField[] => [
    { key: `invested${item.level}`, section: "invested", label: `Invested: ${item.label}`, source: "prefill", origin: "class-completions" },
    { key: `investedAdvanced${item.level}`, section: "invested", label: `Invested: ${item.advancedLabel}`, source: "manual" },
  ]),
  { key: "investedMASTER_GUIDE", section: "invested", label: "Invested: Master Guide", source: "prefill", origin: "class-completions" },
  { key: "honors", section: "honors", label: "Honors awarded (not counting Masters)", source: "prefill", origin: "honors" },
  { key: "honorMasters", section: "honorMasters", label: "Honor Masters awarded", source: "prefill", origin: "honors" },
  { key: "leadershipAward", section: "leadershipAward", label: "Staff completing the Pathfinder Leadership Award", source: "manual" },
  { key: "instructorAward", section: "instructorAward", label: "Staff completing the Pathfinder Instructor Award", source: "manual" },
];

export const yearEndFieldKeys = yearEndFields.map((field) => field.key);
export const prefillKeys = yearEndFields.filter((field) => field.source === "prefill").map((field) => field.key);
export const manualKeys = yearEndFields.filter((field) => field.source === "manual").map((field) => field.key);

export type YearEndCounts = Record<string, number>;
export type YearEndPrefill = Record<string, number>;

const sum = (values: YearEndCounts, keys: readonly string[]) => keys.reduce((total, key) => total + (values[key] ?? 0), 0);

const membershipKeys = yearEndFields.filter((field) => field.section === "membership").map((field) => field.key);
const staffKeys = yearEndFields.filter((field) => field.section === "staff").map((field) => field.key);
const tltKeys = yearEndFields.filter((field) => field.section === "tlts").map((field) => field.key);
const youthBaptismKeys = yearEndFields.filter((field) => field.section === "youthBaptisms").map((field) => field.key);
const investedKeys = yearEndFields.filter((field) => field.section === "invested").map((field) => field.key);

/** Every total on the form. Always calculated from the resolved counts, never typed in. */
export function yearEndTotals(values: YearEndCounts) {
  const membership = sum(values, membershipKeys);
  const staff = sum(values, staffKeys);
  return {
    membership,
    staff,
    totalMembership: membership + staff,
    tlts: sum(values, tltKeys),
    youthBaptisms: sum(values, youthBaptismKeys),
    invested: sum(values, investedKeys),
  };
}

export type YearEndTotals = ReturnType<typeof yearEndTotals>;

export type ResolvedField = {
  value: number;
  /** The pre-filled number, kept beside any override; null for manual fields or when the platform had nothing. */
  prefill: number | null;
  overridden: boolean;
};

/**
 * The number each field carries: a director's override wins over the
 * pre-filled snapshot; manual fields carry what was typed. Missing is 0.
 */
export function resolveYearEnd(input: {
  prefill: Record<string, unknown>;
  overrides: Record<string, unknown>;
  manual: Record<string, unknown>;
}): Record<string, ResolvedField> {
  const asCount = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
  return Object.fromEntries(yearEndFields.map((field): [string, ResolvedField] => {
    if (field.source === "manual") {
      return [field.key, { value: asCount(input.manual[field.key]) ?? 0, prefill: null, overridden: false }];
    }
    const prefill = asCount(input.prefill[field.key]);
    const override = asCount(input.overrides[field.key]);
    return [field.key, { value: override ?? prefill ?? 0, prefill, overridden: override !== null && override !== prefill }];
  }));
}

export function resolvedCounts(resolved: Record<string, ResolvedField>): YearEndCounts {
  return Object.fromEntries(Object.entries(resolved).map(([key, field]) => [key, field.value]));
}

/**
 * Splits the director's typed numbers into what is stored: an override only
 * where a pre-filled field differs from the pre-filled number (a blank or an
 * equal number is no override), and the manual fields as typed.
 */
export function splitYearEndValues(values: Record<string, number | null | undefined>, prefill: YearEndPrefill) {
  const overrides: Record<string, number> = {};
  const manual: Record<string, number> = {};
  for (const field of yearEndFields) {
    const value = values[field.key];
    if (value === null || value === undefined) continue;
    if (field.source === "manual") manual[field.key] = value;
    else if (value !== (prefill[field.key] ?? 0)) overrides[field.key] = value;
  }
  return { overrides, manual };
}

// ---------------------------------------------------------------------------
// Pre-fill rules (pure; the repository does the reading)

/**
 * Grade isn't stored anywhere, so the roster falls back to age on the report
 * date, using the paper form's bands: grades 5-7 = ages 10-12, grades 8-10 =
 * 13-15, grades 11-12 = 16-18. Any other age has no band (null): those members
 * are counted as "not placed" rather than folded into the nearest band.
 */
export function gradeBandForAge(age: number): GradeBand | null {
  if (age < 10 || age > 18) return null;
  if (age <= 12) return "57";
  if (age <= 15) return "810";
  return "1112";
}

export type RosterCountMember = {
  attendeeType: "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE";
  classLevel: string | null;
  gender: "MALE" | "FEMALE" | null;
  /** Age on the report date, or null when there is no birth date or reported age. */
  age: number | null;
};

export type RosterPrefill = {
  counts: Record<string, number>;
  /** Members left out of a cell because a gender or age isn't usable: counts only, never names. */
  unplaced: {
    membersWithoutGender: number;
    membersWithoutAge: number;
    /** Members whose age is under 10 or over 18: outside the paper form's bands, and out of the membership totals. */
    membersAgeOutsideBands: number;
    staffWithoutGender: number;
  };
  /** TLTs on the roster (youth, or staff with the TLT class); their level (1 to 4) isn't stored, so the level cells stay manual. */
  tltsOnRoster: number;
};

/**
 * Sections 1 and 2 from the roster. Membership is youth members plus anyone
 * with the TLT class level, staff included (the form says membership includes
 * TLTs), by age band and gender. Underage children aren't club members. Staff
 * is registered STAFF who aren't TLTs, by gender. A member without a gender or
 * a usable age, or with an age outside 10 to 18, can't be placed and is counted
 * separately so the director knows to fill the gap.
 */
export function prefillFromRoster(members: readonly RosterCountMember[]): RosterPrefill {
  const counts: Record<string, number> = {};
  for (const key of [...membershipKeys, ...staffKeys]) counts[key] = 0;
  const unplaced = { membersWithoutGender: 0, membersWithoutAge: 0, membersAgeOutsideBands: 0, staffWithoutGender: 0 };
  let tltsOnRoster = 0;
  for (const member of members) {
    const gender = member.gender === "MALE" ? "Male" : member.gender === "FEMALE" ? "Female" : null;
    const isTlt = member.classLevel === "TLT" && (member.attendeeType === "YOUTH" || member.attendeeType === "STAFF");
    if (isTlt) tltsOnRoster += 1;
    if (member.attendeeType === "YOUTH" || isTlt) {
      if (!gender) {
        unplaced.membersWithoutGender += 1;
        continue;
      }
      if (member.age === null) {
        unplaced.membersWithoutAge += 1;
        continue;
      }
      const band = gradeBandForAge(member.age);
      if (!band) {
        unplaced.membersAgeOutsideBands += 1;
        continue;
      }
      counts[`member${gender}${band}`] += 1;
    } else if (member.attendeeType === "STAFF") {
      if (!gender) {
        unplaced.staffWithoutGender += 1;
        continue;
      }
      counts[`staff${gender}`] += 1;
    }
  }
  return { counts, unplaced, tltsOnRoster };
}

/**
 * Whether a roster row counts for the year: currently ACTIVE, or it stopped
 * being active (went inactive or was removed) on or after the year's first
 * day, so it was active at some point in the year. `stoppedAt` is the row's
 * `removedAt`, or its last update when it has no removal date.
 */
export function wasActiveDuringYear(
  member: { status: "ACTIVE" | "INACTIVE" | "REMOVED"; removedAt: Date | null; updatedAt: Date },
  reportYear: string,
) {
  if (member.status === "ACTIVE") return true;
  return (member.removedAt ?? member.updatedAt) >= reportYearStartInstant(reportYear);
}

/**
 * Section 7 from class completions: how many completed each class with a
 * completion date inside the Pathfinder year. Only the base class is
 * recorded, so the advanced level (Trail Friend and so on) stays manual.
 */
export function prefillInvestitures(completions: ReadonlyArray<{ classLevel: string; completedOn: string }>, reportYear: string) {
  const counts: Record<string, number> = {};
  for (const item of advancedClasses) counts[`invested${item.level}`] = 0;
  counts.investedMASTER_GUIDE = 0;
  for (const completion of completions) {
    if (!isInReportYear(completion.completedOn, reportYear)) continue;
    const key = `invested${completion.classLevel}`;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

export type HonorEntryFact = {
  personId: string;
  honorId: string;
  status: string;
  completionDate: string;
  /** The club that recorded the entry. */
  organizationId: string;
  voided: boolean;
  isMaster: boolean;
};

/**
 * Sections 8 and 9. `entries` are every entry for the roster's people, newest
 * first (highest `seq` first), voided ones included. Current status per
 * (person, honor) is the latest non-voided entry (#591, the same rule as
 * `currentHonorsFromHistory`). Only a current entry this club recorded counts,
 * and only when COMPLETED with a date inside the year, so an honor recorded by
 * another club is never counted here. Master Awards are counted apart.
 */
export function prefillHonorsForClub(entries: readonly HonorEntryFact[], clubId: string, reportYear: string) {
  const current = new Map<string, HonorEntryFact>();
  for (const entry of entries) {
    if (entry.voided) continue;
    const key = `${entry.personId}:${entry.honorId}`;
    if (!current.has(key)) current.set(key, entry);
  }
  let regular = 0;
  let masters = 0;
  for (const entry of current.values()) {
    if (entry.organizationId !== clubId || entry.status !== "COMPLETED" || !isInReportYear(entry.completionDate, reportYear)) continue;
    if (entry.isMaster) masters += 1;
    else regular += 1;
  }
  return { honors: regular, honorMasters: masters };
}

export const yearEndSectionTitles: Record<YearEndSection, string> = {
  membership: "1. Membership (including TLTs, not adult staff)",
  staff: "2. Staff (not including TLTs)",
  tlts: "4. TLTs",
  youthBaptisms: "5. Youth baptisms (from the church clerk's quarterly report)",
  adultBaptisms: "6. Adult baptisms",
  invested: "7. Number invested",
  honors: "8. Honors awarded (not counting Masters)",
  honorMasters: "9. Honor Masters awarded",
  leadershipAward: "10. Staff completing the Pathfinder Leadership Award",
  instructorAward: "11. Staff completing the Pathfinder Instructor Award",
};

export function formatReportYearDueDate(reportYear: string) {
  const [year, month, day] = reportYearDueDate(reportYear).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function reportYearSpanLabel(reportYear: string) {
  const start = reportYearStart(reportYear);
  return `May 1, ${start} to April 30, ${start + 1}`;
}

/** Submitted and missing counts for the staff list: a club that has not submitted (draft or nothing) is missing. */
export function yearEndProgress(clubs: ReadonlyArray<{ status: "NONE" | "DRAFT" | "SUBMITTED" }>) {
  const submitted = clubs.filter((club) => club.status === "SUBMITTED").length;
  return { submitted, missing: clubs.length - submitted, drafts: clubs.filter((club) => club.status === "DRAFT").length };
}
