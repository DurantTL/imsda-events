import { parseRosterBirthDateInput } from "@/modules/club-rosters/domain";
import { CsvImportError, parseCsvMatrix } from "@/modules/imports/csv-parser";
import { toCsv } from "@/modules/reporting/csv";
import {
  backgroundFlagLabels,
  COMPLIANCE_FILTER_VALUES,
  complianceFilterLabels,
  complianceFilterState,
  type BackgroundCheckState,
  type ClubComplianceState,
  type ComplianceFilterValue,
} from "@/modules/background-checks/display";

// Re-exported so server code keeps importing everything from this module.
export {
  backgroundFlagLabels,
  COMPLIANCE_FILTER_VALUES,
  complianceFilterLabels,
  complianceFilterState,
  type BackgroundCheckState,
  type ClubComplianceState,
  type ComplianceFilterValue,
};

/**
 * Sterling Volunteers background checks (#388). Pure: reading the CSV a system
 * administrator uploads, and deciding who at a youth or children's event is an
 * adult who needs a current check. Flags only; nothing here blocks anyone.
 */

export const STERLING_CSV_HEADERS = ["First name", "Last name", "Email", "Birth date", "Check date", "Expiration date", "Status"] as const;
export const MAX_STERLING_CSV_ROWS = 2_000;
export const MAX_STERLING_CSV_BYTES = 600_000;

export function sterlingCsvTemplate() {
  return toCsv([[...STERLING_CSV_HEADERS]]);
}

export type SterlingCsvRow = {
  line: number;
  firstName: string;
  lastName: string;
  email: string | null;
  /** Used only to match a person; never stored. */
  birthDate: string | null;
  checkedOn: string | null;
  expiresOn: string | null;
  status: string | null;
  problems: string[];
};

type Column = "firstName" | "lastName" | "fullName" | "email" | "birthDate" | "checkedOn" | "expiresOn" | "status";

/** Header spellings, lower-case with spaces, punctuation, and underscores removed. */
const headerKeys: Record<string, Column> = {
  firstname: "firstName",
  first: "firstName",
  givenname: "firstName",
  lastname: "lastName",
  last: "lastName",
  surname: "lastName",
  familyname: "lastName",
  name: "fullName",
  fullname: "fullName",
  volunteername: "fullName",
  candidatename: "fullName",
  email: "email",
  emailaddress: "email",
  birthdate: "birthDate",
  dateofbirth: "birthDate",
  dob: "birthDate",
  checkdate: "checkedOn",
  datecompleted: "checkedOn",
  completeddate: "checkedOn",
  completed: "checkedOn",
  completedon: "checkedOn",
  reportdate: "checkedOn",
  clearedon: "checkedOn",
  cleareddate: "checkedOn",
  expirationdate: "expiresOn",
  expiration: "expiresOn",
  expires: "expiresOn",
  expireson: "expiresOn",
  expiry: "expiresOn",
  expirydate: "expiresOn",
  validuntil: "expiresOn",
  validthrough: "expiresOn",
  renewaldate: "expiresOn",
  status: "status",
  result: "status",
  checkstatus: "status",
  eligibility: "status",
};

/** Statuses that mean the check passed. Anything else is reported, never stored. */
const CLEAR_STATUSES = new Set([
  "clear", "cleared", "complete", "completed", "eligible", "pass", "passed", "approved", "meets criteria", "meets requirements", "valid", "active", "current",
]);

export function isClearStatus(status: string | null) {
  return status === null || CLEAR_STATUSES.has(status.trim().toLowerCase().replace(/\s+/g, " "));
}

const clean = (value: string | undefined) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

/**
 * "2026-09-23", "9/23/2026", "09/23/2026", or "9/23/2026 10:15 AM" → "2026-09-23".
 * Two-digit years (`6/30/28`) are rejected: check and expiration dates run
 * into the future, so the roster's birth-date century rule would misread
 * them (#424).
 */
export function normalizeCheckDate(value: string) {
  const date = clean(value).split(/[ T]/)[0] ?? "";
  const normalized = parseRosterBirthDateInput(date, undefined, { allowTwoDigitYear: false });
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month! - 1 && probe.getUTCDate() === day ? normalized : null;
}

/** A name for matching: case, accents, punctuation, and spacing don't matter. */
export function matchableName(value: string) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function splitFullName(value: string) {
  if (value.includes(",")) {
    const [last, ...rest] = value.split(",");
    return { firstName: clean(rest.join(" ")), lastName: clean(last) };
  }
  const parts = value.split(" ").filter(Boolean);
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) ?? "" };
}

export class SterlingCsvError extends Error {}

export function parseSterlingCsv(text: string): SterlingCsvRow[] {
  if (text.length > MAX_STERLING_CSV_BYTES) throw new SterlingCsvError("That file is too large. Upload up to 2,000 people at a time.");
  let matrix: string[][];
  try {
    matrix = parseCsvMatrix(text.replace(/^﻿/, ""));
  } catch (error) {
    if (error instanceof CsvImportError) throw new SterlingCsvError("That file couldn't be read as a CSV.");
    throw error;
  }
  const [header = [], ...body] = matrix;
  const columns = header.map((cell) => headerKeys[clean(cell).toLowerCase().replace(/[^a-z]/g, "")] ?? null);
  const has = (column: Column) => columns.includes(column);
  if (!(has("firstName") && has("lastName")) && !has("fullName")) {
    throw new SterlingCsvError("The file needs First name and Last name columns (or a Name column). Download the template to see the layout.");
  }
  if (!has("expiresOn")) throw new SterlingCsvError("The file needs an Expiration date column, so we know how long each check lasts.");
  if (!has("email") && !has("birthDate")) {
    throw new SterlingCsvError("The file needs an Email or Birth date column. People are matched by name plus one of them.");
  }
  if (body.length > MAX_STERLING_CSV_ROWS) throw new SterlingCsvError("That file has too many rows. Upload up to 2,000 people at a time.");

  return body.map((cells, index) => {
    const value = (column: Column) => {
      const at = columns.indexOf(column);
      return at >= 0 ? clean(cells[at]) : "";
    };
    const problems: string[] = [];
    let firstName = value("firstName");
    let lastName = value("lastName");
    if ((!firstName || !lastName) && value("fullName")) ({ firstName, lastName } = splitFullName(value("fullName")));
    if (!firstName || !lastName) problems.push("First and last name are needed.");
    const email = value("email").toLowerCase() || null;
    const birthRaw = value("birthDate");
    const birthDate = birthRaw ? normalizeCheckDate(birthRaw) : null;
    if (birthRaw && !birthDate) problems.push("The birth date isn't a date (use 2026-09-23 or 9/23/2026).");
    if (!email && !birthDate) problems.push("An email or birth date is needed to match the person.");
    const checkedRaw = value("checkedOn");
    const checkedOn = checkedRaw ? normalizeCheckDate(checkedRaw) : null;
    if (checkedRaw && !checkedOn) problems.push("The check date isn't a date.");
    const expiresRaw = value("expiresOn");
    const expiresOn = expiresRaw ? normalizeCheckDate(expiresRaw) : null;
    if (!expiresRaw) problems.push("The expiration date is blank.");
    else if (!expiresOn) problems.push("The expiration date isn't a date.");
    const status = value("status") || null;
    // As before #527: only a clear check is ever recorded. A non-clear result
    // is reported to the administrator and stored nowhere (#527 decision).
    if (!isClearStatus(status)) problems.push(`Status is "${status}", not a clear check, so nothing was recorded. Review this person in Sterling.`);
    return { line: index + 2, firstName, lastName, email, birthDate, checkedOn, expiresOn, status, problems };
  });
}

/** Current on `onDate` (a calendar date): the check lasts through its expiration date. */
export function checkIsCurrent(check: { expiresOn: string | null } | null | undefined, onDate: string) {
  return Boolean(check?.expiresOn && check.expiresOn >= onDate);
}

export type BackgroundComplianceStatus = "CLEAR" | "FLAGGED" | "NOT_COMPLIANT";

/**
 * The one row kept per person carries whichever upload was newest (#427):
 * a Sterling upload clears the roster import's compliance mark, and a roster
 * import clears Sterling's dates. So a row with a compliance mark is a roster
 * import's check, and a row without one is a Sterling check.
 */
type StoredCheck = { expiresOn: string | null; complianceStatus?: BackgroundComplianceStatus | null };

/**
 * A person's check at a youth or children's event, through `onDate` (the
 * event's last day). A roster import's mark decides when there is one:
 * Clear and "!" (expiring soon — still on file and in compliance today) are
 * current, Not in compliance is flagged. A Sterling check is current through
 * its expiration date. Nothing on file is missing.
 */
export function backgroundCheckState(check: StoredCheck | null | undefined, onDate: string): BackgroundCheckState {
  if (!check) return "MISSING";
  if (check.complianceStatus) return check.complianceStatus === "NOT_COMPLIANT" ? "NOT_COMPLIANT" : "CURRENT";
  if (!check.expiresOn) return "MISSING";
  return checkIsCurrent(check, onDate) ? "CURRENT" : "EXPIRED";
}

export const ADULT_AGE = 18;

/** Attendee types that are adults even when no age is known. */
const ADULT_TYPE_PATTERN = /\b(adults?|staff|parents?|chaperones?|sponsors?|counsell?ors?|volunteers?|directors?|deputy|leaders?|pastors?|drivers?|guardians?)\b/i;

/**
 * Whether a registered person is an adult for background checks. A known age
 * decides (so an under-18 TLT registered as staff isn't flagged); without one,
 * the club roster type or the attendee type does.
 */
export function attendeeIsAdult(input: {
  ageOnEventDate: number | null;
  rosterAttendeeType?: string | null;
  attendeeType: string;
}) {
  if (input.ageOnEventDate !== null && Number.isFinite(input.ageOnEventDate)) return input.ageOnEventDate >= ADULT_AGE;
  if (input.rosterAttendeeType) return input.rosterAttendeeType === "STAFF" || input.rosterAttendeeType === "ADULT";
  return ADULT_TYPE_PATTERN.test(input.attendeeType);
}

/** An age answer on the form ("16", "16 years"), or null. */
export function ageFromAnswer(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,3})\b/.exec(value);
  return match ? Number(match[1]) : null;
}

// --- Roster import (#427): the real church/club export, matched by name and
// location instead of email or birth date. ---

export const ROSTER_CSV_HEADERS = ["user_id", "user_last", "user_first", "roles", "sites", "user_active", "compliance", "issues"] as const;
export const MAX_ROSTER_CSV_ROWS = 5_000;
/** Headroom for 5,000 short rows plus a wide `issues` note on some of them. */
export const MAX_ROSTER_CSV_BYTES = 1_500_000;

export function rosterBackgroundCsvTemplate() {
  return toCsv([[...ROSTER_CSV_HEADERS], ["111111", "Swanson", "Joe", "something", "Church", "y", "y", "notes"]]);
}

export type RosterBackgroundCsvRow = {
  line: number;
  /** The provider's id for this person; remembered as an external id once matched. */
  userId: string | null;
  firstName: string;
  lastName: string;
  roles: string | null;
  /** A church or club name, compared against a candidate's club or sponsoring church. */
  site: string | null;
  /** Null only when the row's `compliance` value is none of y, "!", or n; `problems` explains why. Never guessed. */
  compliance: BackgroundComplianceStatus | null;
  /** Staff-only note; never shown to a club. Gives the check and training dates (e.g. which one is expiring soon). */
  issuesNote: string | null;
  problems: string[];
};

type RosterColumn = "userId" | "firstName" | "lastName" | "roles" | "site" | "ignored" | "compliance" | "issuesNote";

/** Header spellings, lower-case with everything but letters removed (so `user_id` and `User Id` both match). */
const rosterHeaderKeys: Record<string, RosterColumn> = {
  userid: "userId",
  id: "userId",
  providerid: "userId",
  userlast: "lastName",
  lastname: "lastName",
  last: "lastName",
  surname: "lastName",
  userfirst: "firstName",
  firstname: "firstName",
  first: "firstName",
  roles: "roles",
  role: "roles",
  sites: "site",
  site: "site",
  location: "site",
  church: "site",
  club: "site",
  // Accepted so the real export reads as-is, but not used (#427: whether the
  // account is active doesn't matter, only compliance does).
  useractive: "ignored",
  active: "ignored",
  compliance: "compliance",
  compliant: "compliance",
  issues: "issuesNote",
  issue: "issuesNote",
  notes: "issuesNote",
  note: "issuesNote",
};

/** The `compliance` column, case-insensitive. Anything else, blank included, is a row problem. */
const complianceValues: Record<string, BackgroundComplianceStatus> = {
  y: "CLEAR",
  yes: "CLEAR",
  "!": "FLAGGED",
  n: "NOT_COMPLIANT",
  no: "NOT_COMPLIANT",
};

/**
 * Whether a header row is the roster import's template rather than Sterling's.
 * `user_id` alone decides, so a roster file missing another column gets the
 * roster import's own message naming that column.
 */
export function isRosterBackgroundCsvHeader(header: string[]) {
  return header.some((cell) => clean(cell).toLowerCase().replace(/[^a-z]/g, "") === "userid");
}

/**
 * Which template an uploaded CSV is (#427), from its header row alone, so the
 * importer accepts either without asking. Falls back to Sterling (the older
 * format) when nothing marks it as a roster import.
 */
export function detectBackgroundCsvFormat(text: string): "ROSTER" | "STERLING" {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/, 1)[0] ?? "";
  let header: string[][];
  try {
    header = parseCsvMatrix(firstLine);
  } catch {
    return "STERLING";
  }
  return isRosterBackgroundCsvHeader(header[0] ?? []) ? "ROSTER" : "STERLING";
}

export class RosterBackgroundCsvError extends Error {}

/**
 * The real church/club export (#427): `user_id,user_last,user_first,roles,
 * sites,user_active,compliance,issues`. No email or birth date; people are
 * matched by name and `sites` (their club or sponsoring church) at lookup
 * (#527, `modules/background-checks/repository.ts`). `user_active` is
 * accepted and ignored.
 */
export function parseRosterBackgroundCsv(text: string): RosterBackgroundCsvRow[] {
  if (text.length > MAX_ROSTER_CSV_BYTES) throw new RosterBackgroundCsvError("That file is too large. Upload up to 5,000 people at a time.");
  let matrix: string[][];
  try {
    matrix = parseCsvMatrix(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error instanceof CsvImportError) throw new RosterBackgroundCsvError("That file couldn't be read as a CSV.");
    throw error;
  }
  const [header = [], ...body] = matrix;
  const columns = header.map((cell) => rosterHeaderKeys[clean(cell).toLowerCase().replace(/[^a-z]/g, "")] ?? null);
  const has = (column: RosterColumn) => columns.includes(column);
  if (!has("userId")) throw new RosterBackgroundCsvError("The file needs a user_id column, so the same person is remembered next time.");
  if (!has("lastName") || !has("firstName")) throw new RosterBackgroundCsvError("The file needs user_last and user_first columns.");
  if (!has("compliance")) throw new RosterBackgroundCsvError('The file needs a compliance column (y, n, or "!").');
  if (body.length > MAX_ROSTER_CSV_ROWS) throw new RosterBackgroundCsvError("That file has too many rows. Upload up to 5,000 people at a time.");

  return body.map((cells, index) => {
    const value = (column: RosterColumn) => {
      const at = columns.indexOf(column);
      return at >= 0 ? clean(cells[at]) : "";
    };
    const problems: string[] = [];
    const userId = value("userId") || null;
    if (!userId) problems.push("A user_id is needed so this person is remembered next time.");
    const firstName = value("firstName");
    const lastName = value("lastName");
    if (!firstName || !lastName) problems.push("user_first and user_last are needed.");
    const roles = value("roles") || null;
    const site = value("site") || null;
    const compliance = complianceValues[value("compliance").toLowerCase()] ?? null;
    if (!compliance) problems.push('compliance must be "y", "n", or "!".');
    const issuesNote = value("issuesNote") || null;
    return { line: index + 2, userId, firstName, lastName, roles, site, compliance, issuesNote, problems };
  });
}

const siteNoiseWords = /\b(?:seventh day adventist|sda|church|company|group|pathfinders?|adventurers?|club)\b/g;
const siteNoiseWordSet = new Set(["seventh", "day", "adventist", "sda", "church", "company", "group", "pathfinder", "pathfinders", "adventurer", "adventurers", "club"]);
const genericStemWords = new Set(["adventist", "seventh", "day", "first", "central"]);
const usStateCodes = new Set((
  "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy"
).split(" "));

function siteStem(value: string) {
  return matchableName(value.replace(/[-‐-―]/g, " ")).replace(siteNoiseWords, " ").replace(/\s+/g, " ").trim();
}

/** A stem too short or too generic to identify a site: never used for matching. */
function isGenericStem(stem: string) {
  if (stem.length < 3) return true;
  const words = stem.split(" ");
  return words.every((word) => genericStemWords.has(word) || usStateCodes.has(word));
}

function parenthesesBalanced(value: string) {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** True when a piece is just a state code, optionally followed by church words ("MO SDA Church"). */
function startsWithStateCode(piece: string) {
  const [first, ...rest] = matchableName(piece.replace(/[-‐-―]/g, " ")).split(" ");
  return Boolean(first) && usStateCodes.has(first!) && first!.length === 2 && rest.every((word) => siteNoiseWordSet.has(word));
}

type SitePart = { text: string; /** The part without a merged state-code piece, when one was merged in. */ withoutState: string | null };

/**
 * Splits a `sites` cell into sites on commas outside parentheses. With
 * unbalanced parentheses it falls back to every comma. A piece that only
 * carries a state code ("Springfield, MO SDA Church") stays with its site.
 */
function splitSiteList(value: string): SitePart[] {
  const balanced = parenthesesBalanced(value);
  const raw: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (balanced && char === "(") depth += 1;
    else if (balanced && char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      raw.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  raw.push(current);
  const parts: SitePart[] = [];
  for (const piece of raw) {
    const last = parts[parts.length - 1];
    if (last && startsWithStateCode(piece)) {
      parts[parts.length - 1] = { text: `${last.text}, ${piece}`, withoutState: last.withoutState ?? last.text };
    } else {
      parts.push({ text: piece, withoutState: null });
    }
  }
  return parts;
}

/** The part without one trailing parenthetical (the export's city suffix), or null when it has none. */
function withoutTrailingParenthetical(part: string) {
  const trimmed = part.trim();
  if (!trimmed.endsWith(")") || !parenthesesBalanced(trimmed)) return null;
  let depth = 0;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] === ")") depth += 1;
    else if (trimmed[index] === "(") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(0, index);
    }
  }
  return null;
}

/**
 * Comparison keys for one row's `sites` cell (#572). A cell may hold several
 * comma-separated sites. Each site gives its full stem. Only when that full
 * stem is no directory site's own full stem (`directoryStems`) does it also
 * give fallback keys: the stem without one trailing parenthetical (the
 * export's city suffix), and the stem without a merged state code
 * ("Springfield, MO SDA Church" also reads "springfield"). Other
 * parenthetical text is part of the name: `Nevada (IA)` is never
 * `Nevada (MO)`. The stem ignores case, accents, punctuation,
 * "Seventh-day Adventist", "SDA", "Church", "Company", "Group", and club
 * words; school and academy words stay. Empty or generic stems are dropped.
 */
export function siteStems(value: string, directoryStems: ReadonlySet<string> = new Set()): Set<string> {
  const stems = new Set<string>();
  const add = (text: string) => {
    const stem = siteStem(text);
    if (stem && !isGenericStem(stem)) stems.add(stem);
  };
  for (const part of splitSiteList(value)) {
    const full = siteStem(part.text);
    add(part.text);
    if (directoryStems.has(full)) continue;
    const trimmed = withoutTrailingParenthetical(part.text);
    if (trimmed !== null) add(trimmed);
    if (part.withoutState !== null) add(part.withoutState);
  }
  return stems;
}

/** The comparison key for one directory club or church name: it is a single site, never split. */
export function candidateSiteStems(value: string): Set<string> {
  const stem = siteStem(value);
  return stem && !isGenericStem(stem) ? new Set([stem]) : new Set();
}

/** The full stems of every directory club and church name, for `matchesSite`'s fallback rule. */
export function directorySiteStems(names: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const name of names) for (const stem of candidateSiteStems(name)) stems.add(stem);
  return stems;
}

/** The shortest first name a variant suggestion compares (#598): "Al" would suggest half the list. */
export const MIN_FIRST_NAME_VARIANT_LENGTH = 3;

/**
 * Whether two first names are forms of one name (#598): "Jon"/"Jonathan",
 * "Nessa"/"Vanessa". One is a prefix of the other, or contained in it, and
 * the shorter is at least 3 characters. Equal names are not variants (they
 * are the same name), and this only ever suggests: it never decides a match.
 */
export function firstNameVariant(a: string, b: string) {
  const left = matchableName(a).replace(/ /g, "");
  const right = matchableName(b).replace(/ /g, "");
  if (!left || !right || left === right) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= MIN_FIRST_NAME_VARIANT_LENGTH && long.includes(short);
}

/** "First Last" or "Last, First" typed into the lookup box, as first and last names. */
export function parseLookupName(value: string) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.includes(",")) {
    const [last, ...rest] = trimmed.split(",");
    return { firstName: rest.join(" ").trim(), lastName: (last ?? "").trim() };
  }
  const parts = trimmed.split(" ").filter(Boolean);
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) ?? "" };
}

/** A club's own name or its sponsoring church's name, for the `sites` location check. */
export function matchesSite(site: string, candidateSites: Iterable<string>, directoryStems: ReadonlySet<string> = new Set()) {
  const targets = siteStems(site, directoryStems);
  if (targets.size === 0) return false;
  for (const candidate of candidateSites) {
    for (const stem of candidateSiteStems(candidate)) {
      if (targets.has(stem)) return true;
    }
  }
  return false;
}

/**
 * How a club page shows one person (#427). A roster import's mark is used
 * when there is one: Clear, Expiring soon ("!", `FLAGGED`), or Not in
 * compliance. Without one, a Sterling check is Clear through its expiration
 * date and Not in compliance after it. Nothing on file is "No record", which
 * is not counted as not in compliance.
 */
export function clubComplianceState(check: StoredCheck | null | undefined, today: string): ClubComplianceState {
  if (!check) return "NO_RECORD";
  if (check.complianceStatus) return check.complianceStatus;
  if (check.expiresOn) {
    if (check.expiresOn < today) return "NOT_COMPLIANT";
    // A Sterling check ending within 60 days reads as expiring soon, as on the admin summary.
    const soon = new Date(`${today}T12:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + 60);
    return check.expiresOn <= soon.toISOString().slice(0, 10) ? "FLAGGED" : "CLEAR";
  }
  return "NO_RECORD";
}

/**
 * Counts behind the club home "What's next" and club overview reminders
 * (#479): how many active adult roster members are missing a current check,
 * not in compliance (an expired Sterling check, or a roster import's "n"
 * mark), or expiring within 60 days ("!"). "Missing" is counted here even
 * though the roster's own inline notice never counts it (#427) — a home-page
 * reminder to add a check is a different message from a warning about one
 * already on file.
 */
export type ComplianceReminderCounts = { missing: number; notInCompliance: number; expiringSoon: number };

/**
 * Never blocks registration (#405): flags only, as counts with a link to the
 * filtered roster. Never anyone's name; that stays behind the roster
 * column's own access rule. Skips a count that is zero, so a club with
 * nothing outstanding sees no reminder at all.
 */
export function complianceReminders(counts: ComplianceReminderCounts, rosterHref: string) {
  const items: Array<{ key: string; text: string; href: string }> = [];
  if (counts.missing > 0) {
    items.push({
      key: "background-check-missing",
      text: `${counts.missing} adult${counts.missing === 1 ? "" : "s"} missing a current background check.`,
      href: `${rosterHref}?compliance=missing`,
    });
  }
  if (counts.notInCompliance > 0) {
    items.push({
      key: "background-check-not-compliant",
      text: `${counts.notInCompliance} background check${counts.notInCompliance === 1 ? "" : "s"} expired or not in compliance.`,
      href: `${rosterHref}?compliance=expired`,
    });
  }
  if (counts.expiringSoon > 0) {
    items.push({
      key: "background-check-expiring",
      text: `${counts.expiringSoon} background check${counts.expiringSoon === 1 ? " expires" : "s expire"} within 60 days.`,
      href: `${rosterHref}?compliance=expiring`,
    });
  }
  return items;
}

// --- The unified stored list (#527): both CSV formats above are input
// parsers only. Every valid row becomes one of these, fed into the one
// stored list, matched to people at lookup instead of at upload. ---

export type BackgroundCheckListRow = {
  line: number;
  firstName: string;
  lastName: string;
  normalizedName: string;
  email: string | null;
  /** Plain here; the repository seals it (`club-rosters/birth-dates.ts`) before storage. */
  birthDate: string | null;
  /** The person's club or sponsoring church (the roster format's `sites`). */
  site: string | null;
  /** The roster CSV's `user_id`, when the row has one (Sterling rows never do). */
  sourceUserId: string | null;
  /** What a remembered or manual match is kept against; see `backgroundCheckIdentityKey`. */
  identityKey: string;
  complianceStatus: BackgroundComplianceStatus | null;
  checkedOn: string | null;
  expiresOn: string | null;
  issuesNote: string | null;
};

/**
 * The one format a roster `user_id` is kept in, both as a list entry's
 * `identityKey` and as `ExternalIdentity.externalId` (provider
 * `ROSTER_IMPORT`). The #527 migration rewrites identities remembered before
 * it (the raw id) into this format, so nothing remembered is orphaned.
 */
export const USER_ID_IDENTITY_PREFIX = "userId:";

export function userIdIdentityKey(userId: string) {
  return `${USER_ID_IDENTITY_PREFIX}${userId}`;
}

/**
 * Only a provider `user_id` is ever remembered as an `ExternalIdentity`
 * (#527 N3). A key built from a name, email, birth date, or site is not an
 * identity the provider issued — and a person holds only one `ROSTER_IMPORT`
 * identity, so remembering one of those would evict their real `user_id`. A
 * staff match on such an entry is kept by the match itself instead, and
 * carried forward to the next upload's entry with the same key.
 */
export function isRememberedIdentityKey(identityKey: string) {
  return identityKey.startsWith(USER_ID_IDENTITY_PREFIX) && identityKey.length > USER_ID_IDENTITY_PREFIX.length;
}

/**
 * One row per identity key in an upload (#527 B4). The later row is kept, as
 * before, but every earlier row it replaces is reported back as a problem so
 * staff see it — never dropped silently.
 */
export function dedupeListRows<T extends { line: number; identityKey: string; firstName: string; lastName: string }>(rows: T[]): {
  rows: T[];
  duplicates: Array<{ line: number; name: string; problems: string[] }>;
} {
  const byKey = new Map<string, T>();
  const duplicates: Array<{ line: number; name: string; problems: string[] }> = [];
  for (const row of [...rows].sort((a, b) => a.line - b.line)) {
    const earlier = byKey.get(row.identityKey);
    if (earlier) {
      duplicates.push({
        line: earlier.line,
        name: `${earlier.firstName} ${earlier.lastName}`.trim(),
        problems: [`Row ${row.line} is the same person, so only row ${row.line} is kept.`],
      });
    }
    byKey.set(row.identityKey, row);
  }
  return { rows: [...byKey.values()].sort((a, b) => a.line - b.line), duplicates: duplicates.sort((a, b) => a.line - b.line) };
}

/**
 * What recognizes "the same entry" from one upload to the next: the roster
 * CSV's `user_id` when the row has one (also what is remembered as an
 * `ExternalIdentity`, see `isRememberedIdentityKey`), otherwise a key built
 * from the row's own identifying fields in the same priority matching uses
 * them. Upload counts (added/changed/dropped) and carrying a staff match
 * forward both compare by this key.
 */
export function backgroundCheckIdentityKey(input: {
  sourceUserId: string | null;
  normalizedName: string;
  email: string | null;
  birthDate: string | null;
  site: string | null;
}): string {
  if (input.sourceUserId) return userIdIdentityKey(input.sourceUserId);
  // Name as well as email: IMSDA households routinely share one adult's
  // email, so a spouse on the same address is a different entry (#527 B4).
  if (input.email) return `email:${input.email}|${input.normalizedName}`;
  if (input.birthDate) return `name-birth:${input.normalizedName}|${input.birthDate}`;
  if (input.site) return `name-site:${input.normalizedName}|${matchableName(input.site)}`;
  return `name:${input.normalizedName}`;
}

/**
 * A Sterling row (#388) as a list entry. Only a row with no problems — so a
 * clear check (`parseSterlingCsv` reports any other status as a problem) —
 * is ever mapped: dated, with no compliance mark and no note, exactly the
 * fields the Sterling import stored before #527.
 */
export function sterlingRowToListRow(row: SterlingCsvRow): BackgroundCheckListRow {
  const normalizedName = matchableName(`${row.firstName} ${row.lastName}`);
  return {
    line: row.line,
    firstName: row.firstName,
    lastName: row.lastName,
    normalizedName,
    email: row.email,
    birthDate: row.birthDate,
    site: null,
    sourceUserId: null,
    identityKey: backgroundCheckIdentityKey({ sourceUserId: null, normalizedName, email: row.email, birthDate: row.birthDate, site: null }),
    complianceStatus: null,
    checkedOn: row.checkedOn,
    expiresOn: row.expiresOn,
    issuesNote: null,
  };
}

/** A roster row (#427) as a list entry. */
export function rosterRowToListRow(row: RosterBackgroundCsvRow): BackgroundCheckListRow {
  const normalizedName = matchableName(`${row.firstName} ${row.lastName}`);
  return {
    line: row.line,
    firstName: row.firstName,
    lastName: row.lastName,
    normalizedName,
    email: null,
    birthDate: null,
    site: row.site,
    sourceUserId: row.userId,
    identityKey: backgroundCheckIdentityKey({ sourceUserId: row.userId, normalizedName, email: null, birthDate: null, site: row.site }),
    complianceStatus: row.compliance,
    checkedOn: null,
    expiresOn: null,
    issuesNote: row.issuesNote,
  };
}

/** The "Background check needed" list as CSV, for staff and event managers. */
export function backgroundFlagsCsv(people: Array<{
  lastName: string;
  firstName: string;
  attendeeType: string;
  clubName: string | null;
  confirmationCode: string;
  state: Exclude<BackgroundCheckState, "CURRENT">;
  expiresOn: string | null;
}>) {
  return toCsv([
    ["Last name", "First name", "Attendee type", "Club", "Confirmation code", "Background check", "Expired on"],
    ...people.map((person) => [
      person.lastName,
      person.firstName,
      person.attendeeType,
      person.clubName ?? "",
      person.confirmationCode,
      backgroundFlagLabels[person.state],
      person.state === "EXPIRED" ? person.expiresOn ?? "" : "",
    ]),
  ]);
}
