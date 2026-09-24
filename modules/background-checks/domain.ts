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

/** "2026-09-23", "9/23/2026", "09/23/2026", or "9/23/2026 10:15 AM" → "2026-09-23". */
export function normalizeCheckDate(value: string) {
  const date = clean(value).split(/[ T]/)[0] ?? "";
  const normalized = parseRosterBirthDateInput(date);
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
export function checkIsCurrent(check: { expiresOn: string } | null | undefined, onDate: string) {
  return Boolean(check && check.expiresOn >= onDate);
}

export type BackgroundCheckState = "CURRENT" | "EXPIRED" | "MISSING";

export function backgroundCheckState(check: { expiresOn: string } | null | undefined, onDate: string): BackgroundCheckState {
  if (!check) return "MISSING";
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
