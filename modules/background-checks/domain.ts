import { parseRosterBirthDateInput } from "@/modules/club-rosters/domain";
import { CsvImportError, parseCsvMatrix } from "@/modules/imports/csv-parser";
import { toCsv } from "@/modules/reporting/csv";

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
    return { line: index + 2, firstName, lastName, email, birthDate, checkedOn, expiresOn, status, problems };
  });
}

/** Current on `onDate` (a calendar date): the check lasts through its expiration date. */
export function checkIsCurrent(check: { expiresOn: string | null } | null | undefined, onDate: string) {
  return Boolean(check?.expiresOn && check.expiresOn >= onDate);
}

export type BackgroundCheckState = "CURRENT" | "EXPIRED" | "MISSING";

/**
 * Current/expired/missing at a youth or children's event, by date. A roster
 * import's check (no `expiresOn`, just a compliance mark) has no date to
 * compare, so it reads as missing here even when it's on file — see
 * `clubComplianceState` for how a club page shows that same check instead.
 */
export function backgroundCheckState(check: { expiresOn: string | null } | null | undefined, onDate: string): BackgroundCheckState {
  if (!check?.expiresOn) return "MISSING";
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
  /** A church or club name, compared against a candidate's club or sponsoring church to break a name tie. */
  site: string | null;
  active: boolean;
  /** Null only when the row's `compliance` value is none of y, "!", or n; `problems` explains why. Never guessed. */
  compliance: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | null;
  /** Staff-only note; never shown to a club. Says why a `FLAGGED` row was flagged. */
  issuesNote: string | null;
  problems: string[];
};

type RosterColumn = "userId" | "firstName" | "lastName" | "roles" | "site" | "active" | "compliance" | "issuesNote";

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
  useractive: "active",
  active: "active",
  status: "active",
  compliance: "compliance",
  compliant: "compliance",
  issues: "issuesNote",
  issue: "issuesNote",
  notes: "issuesNote",
  note: "issuesNote",
};

const YES_WORDS = new Set(["y", "yes", "true", "1", "active"]);
const NO_WORDS = new Set(["n", "no", "false", "0", "inactive"]);

/** Whether a header row is the roster import's template rather than Sterling's. */
export function isRosterBackgroundCsvHeader(header: string[]) {
  const columns = header.map((cell) => clean(cell).toLowerCase().replace(/[^a-z]/g, ""));
  return columns.includes("userid") && columns.includes("compliance");
}

/**
 * Which template an uploaded CSV is (#427), from its header row alone, so the
 * importer accepts either without asking. Falls back to Sterling (the older
 * format) when nothing marks it as a roster import.
 */
export function detectBackgroundCsvFormat(text: string): "ROSTER" | "STERLING" {
  const firstLine = text.replace(/^﻿/, "").split(/\r\n|\r|\n/, 1)[0] ?? "";
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
 * matched by name (and, if that's ambiguous, `sites` against their club or
 * sponsoring church) in `planRosterBackgroundImport`.
 */
export function parseRosterBackgroundCsv(text: string): RosterBackgroundCsvRow[] {
  if (text.length > MAX_ROSTER_CSV_BYTES) throw new RosterBackgroundCsvError("That file is too large. Upload up to 5,000 people at a time.");
  let matrix: string[][];
  try {
    matrix = parseCsvMatrix(text.replace(/^﻿/, ""));
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
    const activeRaw = value("active").toLowerCase();
    let active = true;
    if (NO_WORDS.has(activeRaw)) active = false;
    else if (activeRaw && !YES_WORDS.has(activeRaw)) problems.push('user_active must be "y" or "n".');
    const complianceRaw = value("compliance").toLowerCase();
    let compliance: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | null = null;
    if (YES_WORDS.has(complianceRaw)) compliance = "CLEAR";
    else if (complianceRaw === "!" || complianceRaw === "flagged" || complianceRaw === "flag") compliance = "FLAGGED";
    else if (NO_WORDS.has(complianceRaw)) compliance = "NOT_COMPLIANT";
    else problems.push('compliance must be "y", "n", or "!".');
    const issuesNote = value("issuesNote") || null;
    return { line: index + 2, userId, firstName, lastName, roles, site, active, compliance, issuesNote, problems };
  });
}

/** A club's own name or its sponsoring church's name, for the `sites` location tie-break. */
export function matchesSite(site: string, candidateSites: Iterable<string>) {
  const target = matchableName(site);
  if (!target) return false;
  for (const candidate of candidateSites) {
    if (matchableName(candidate) === target) return true;
  }
  return false;
}

export type ClubComplianceState = "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | "INACTIVE" | "NO_RECORD";

/**
 * How a club page shows one person (#427). `active: false` (the roster
 * import's `user_active` column) wins over everything else — someone can be
 * disabled, or not in compliance for a while, and either way that's shown as
 * "Inactive", never quietly folded into "No record". Otherwise a roster
 * import's `compliance` mark (Clear/Flagged/Not in compliance) is used when
 * there is one; without one, a Sterling check is current/expired by date. No
 * check on file at all is "No record".
 */
export function clubComplianceState(
  check: { complianceStatus: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | null; active: boolean; expiresOn: string | null } | null | undefined,
  today: string,
): ClubComplianceState {
  if (!check) return "NO_RECORD";
  if (!check.active) return "INACTIVE";
  if (check.complianceStatus) return check.complianceStatus;
  if (check.expiresOn) return check.expiresOn >= today ? "CLEAR" : "NOT_COMPLIANT";
  return "NO_RECORD";
}

/** The "Background check needed" list as CSV, for staff and event managers. */
export function backgroundFlagsCsv(people: Array<{
  lastName: string;
  firstName: string;
  attendeeType: string;
  clubName: string | null;
  confirmationCode: string;
  state: "MISSING" | "EXPIRED";
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
      person.state === "EXPIRED" ? "Expired" : "None on file",
      person.state === "EXPIRED" ? person.expiresOn ?? "" : "",
    ]),
  ]);
}
