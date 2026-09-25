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

export type BackgroundCheckState = "CURRENT" | "EXPIRED" | "MISSING" | "NOT_COMPLIANT";

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
 * matched by name and `sites` (their club or sponsoring church) in
 * `planRosterBackgroundImport`. `user_active` is accepted and ignored.
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

/** A club's own name or its sponsoring church's name, for the `sites` location check. */
export function matchesSite(site: string, candidateSites: Iterable<string>) {
  const target = matchableName(site);
  if (!target) return false;
  for (const candidate of candidateSites) {
    if (matchableName(candidate) === target) return true;
  }
  return false;
}

export type ClubComplianceState = "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | "NO_RECORD";

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
  if (check.expiresOn) return check.expiresOn >= today ? "CLEAR" : "NOT_COMPLIANT";
  return "NO_RECORD";
}

/** How a flag reads on the list and in its CSV. */
export const backgroundFlagLabels = {
  MISSING: "None on file",
  EXPIRED: "Expired",
  NOT_COMPLIANT: "Not in compliance",
} as const satisfies Record<Exclude<BackgroundCheckState, "CURRENT">, string>;

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
