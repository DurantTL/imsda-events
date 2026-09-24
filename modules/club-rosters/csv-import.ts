import { classLevelFrom } from "@/modules/club-imports/domain";
import type { ClubClassLevel } from "@/modules/club-rosters/domain";
import {
  clubRosterAttendeeTypeLabels,
  missingRosterFields,
  parseRosterBirthDateInput,
  rosterFieldLabels,
  rosterRoleOrDefault,
} from "@/modules/club-rosters/domain";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Club roster CSV (#384): a template to fill in, and an upload that adds new
 * people and updates people already on this year's roster. Pure: parsing and
 * planning only; the route applies the plan through the normal roster
 * functions, so every rule (sealed birth dates, duplicates) still holds.
 *
 * A person is matched by name. The preview never shows anything already on
 * file (no birth dates), only what the file says and what will happen.
 */

export const ROSTER_CSV_HEADERS = ["First name", "Last name", "Birth date", "Type", "Current class", "Role", "Gender"] as const;
export const MAX_ROSTER_CSV_ROWS = 500;
export const MAX_ROSTER_CSV_BYTES = 200_000;

export function rosterCsvTemplate() {
  return toCsv([[...ROSTER_CSV_HEADERS]]);
}

type AttendeeType = "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE";

export type RosterCsvRow = {
  line: number;
  firstName: string;
  lastName: string;
  /** Undefined means the cell was blank: keep what's on file. */
  birthDate?: string;
  attendeeType?: AttendeeType;
  classLevel?: ClubClassLevel | null;
  role?: string;
  gender?: "FEMALE" | "MALE" | null;
  problems: string[];
};

const headerKeys: Record<string, keyof Omit<RosterCsvRow, "line" | "problems">> = {
  firstname: "firstName",
  first: "firstName",
  lastname: "lastName",
  last: "lastName",
  birthdate: "birthDate",
  dateofbirth: "birthDate",
  dob: "birthDate",
  type: "attendeeType",
  class: "classLevel",
  classlevel: "classLevel",
  currentclass: "classLevel",
  role: "role",
  gender: "gender",
};

const typeValues: Record<string, AttendeeType> = {
  youth: "YOUTH",
  pathfinder: "YOUTH",
  member: "YOUTH",
  staff: "STAFF",
  adult: "ADULT",
  underage: "UNDERAGE",
};

const clean = (value: string | undefined) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

export class RosterCsvError extends Error {}

/** "2014-04-17", "4/17/2014", or "4/17/14" → "2014-04-17" (#424: the shared century rule). */
export function parseRosterCsv(text: string, currentYear = new Date().getFullYear()): RosterCsvRow[] {
  if (text.length > MAX_ROSTER_CSV_BYTES) throw new RosterCsvError("That file is too large. Upload up to 500 people at a time.");
  const matrix = parseCsvMatrix(text.replace(/^﻿/, ""));
  if (matrix.length === 0) throw new RosterCsvError("That file is empty. Download the template and fill it in.");
  const columns = matrix[0].map((header) => headerKeys[header.toLowerCase().replace(/[^a-z]/g, "")]);
  if (!columns.includes("firstName") || !columns.includes("lastName")) {
    throw new RosterCsvError("The first row needs the column names from the template, including First name and Last name.");
  }
  const body = matrix.slice(1);
  if (body.length > MAX_ROSTER_CSV_ROWS) throw new RosterCsvError("Upload up to 500 people at a time.");

  return body.map((cells, index) => {
    const row: RosterCsvRow = { line: index + 2, firstName: "", lastName: "", problems: [] };
    columns.forEach((key, column) => {
      if (!key) return;
      const value = clean(cells[column]);
      if (key === "firstName" || key === "lastName") {
        row[key] = value.slice(0, 80);
        return;
      }
      if (value === "") return;
      if (key === "birthDate") {
        const date = parseRosterBirthDateInput(value, currentYear);
        if (date) row.birthDate = date;
        else row.problems.push(`Birth date "${value}" isn't a date. Use 2014-04-17, 4/17/2014, or 4/17/14.`);
      } else if (key === "attendeeType") {
        const type = typeValues[value.toLowerCase()];
        if (type) row.attendeeType = type;
        else row.problems.push(`Type "${value}" isn't one of Youth, Staff, Adult, or Underage.`);
      } else if (key === "classLevel") {
        const level = value.toLowerCase() === "none" ? null : classLevelFrom(value);
        if (level !== null || value.toLowerCase() === "none") row.classLevel = level;
        else row.problems.push(`Class "${value}" isn't a Pathfinder class level.`);
      } else if (key === "role") {
        row.role = value.slice(0, 60);
      } else if (key === "gender") {
        const letter = value.toLowerCase()[0];
        if (letter === "f") row.gender = "FEMALE";
        else if (letter === "m") row.gender = "MALE";
        else row.problems.push(`Gender "${value}" should be Female or Male, or left blank.`);
      }
    });
    if (!row.firstName || !row.lastName) row.problems.push("First and last name are both needed.");
    return row;
  });
}

function nameKey(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

const csvFieldOrder = ["birthDate", "attendeeType", "classLevel", "role", "gender"] as const;

/** The roster's fields (#424) an empty CSV cell left blank on this row. */
export function missingRosterCsvFields(row: RosterCsvRow): string[] {
  return csvFieldOrder.filter((field) => row[field] === undefined).map((field) => rosterFieldLabels[field]);
}

/**
 * What a new person from this row will be saved with (#424): a blank type is
 * Youth, and a blank role defaults by type (youth → "Pathfinder", others stay
 * blank). The import route saves exactly this.
 */
export function rosterCsvAddDefaults(row: RosterCsvRow) {
  const attendeeType: AttendeeType = row.attendeeType ?? "YOUTH";
  return { attendeeType, role: rosterRoleOrDefault(row.role, attendeeType) };
}

/**
 * The preview line for a new person (#424): which blanks get a default, then
 * what will still be missing on the roster afterwards.
 */
function addMessage(row: RosterCsvRow) {
  const { attendeeType, role } = rosterCsvAddDefaults(row);
  const defaults: string[] = [];
  if (row.attendeeType === undefined) defaults.push(`${rosterFieldLabels.attendeeType} → ${clubRosterAttendeeTypeLabels[attendeeType]}`);
  if (!(row.role ?? "").trim() && role) defaults.push(`${rosterFieldLabels.role} → ${role}`);
  const missing = missingRosterFields({
    attendeeType,
    role,
    classLevel: row.classLevel ?? null,
    gender: row.gender ?? null,
    birthDateNeeded: !row.birthDate,
  });
  return [
    "Will be added.",
    defaults.length > 0 ? `Will default: ${defaults.join(", ")}.` : "",
    missing.length > 0 ? `Missing: ${missing.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

export type RosterImportStep = {
  line: number;
  name: string;
  action: "ADD" | "UPDATE" | "SKIP";
  memberId: string | null;
  message: string;
  row: RosterCsvRow;
};

/** What the upload will do with each row, against this year's roster (names only). */
export function planRosterImport(rows: readonly RosterCsvRow[], existing: ReadonlyArray<{ id: string; firstName: string; lastName: string }>) {
  const byName = new Map<string, string[]>();
  for (const member of existing) {
    const key = nameKey(member.firstName, member.lastName);
    byName.set(key, [...(byName.get(key) ?? []), member.id]);
  }
  const seen = new Set<string>();
  return rows.map((row): RosterImportStep => {
    const name = `${row.firstName} ${row.lastName}`.trim();
    const key = nameKey(row.firstName, row.lastName);
    const skip = (message: string): RosterImportStep => ({ line: row.line, name, action: "SKIP", memberId: null, message, row });
    if (row.problems.length > 0) return skip(row.problems.join(" "));
    if (seen.has(key)) return skip("This name is already earlier in the file.");
    seen.add(key);
    const matches = byName.get(key) ?? [];
    if (matches.length > 1) return skip("More than one person on the roster has this name. Edit them by hand.");
    if (matches.length === 1) {
      const changes = csvFieldOrder.filter((field) => row[field] !== undefined);
      if (changes.length === 0) return { line: row.line, name, action: "SKIP", memberId: matches[0], message: "Already on the roster; nothing to change.", row };
      // Blank cells on an update keep what's on file (#424), so they're only noted, not called missing.
      const blank = missingRosterCsvFields(row);
      const message = blank.length > 0
        ? `Will update what the file fills in. Blank in file: ${blank.join(", ")} (kept as on file).`
        : "Will update what the file fills in.";
      return { line: row.line, name, action: "UPDATE", memberId: matches[0], message, row };
    }
    if (!row.birthDate) return skip("New people need a birth date.");
    return { line: row.line, name, action: "ADD", memberId: null, message: addMessage(row), row };
  });
}
