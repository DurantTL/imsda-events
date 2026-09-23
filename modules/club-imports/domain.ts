import { z } from "zod";
import { clubYearFor, type ClubClassLevel } from "@/modules/club-rosters/domain";

/**
 * Club import (#376) from the old website's Fluent Forms export of form 89,
 * "Pathfinder Yearly Club Registration". Pure: turns an export into editable
 * drafts, one per entry. Only what a club needs is kept: names, roles, ages,
 * and class levels for the roster, and the leader and co-leader's name and
 * email for invites. Addresses, phone numbers, and the child-protection
 * answers are never read (ADR 0005 keeps background-check data off rosters).
 */

export const CLUB_IMPORT_FORM_ID = "89";
export const MAX_IMPORT_BYTES = 5_000_000;

export type ImportPerson = {
  key: string;
  include: boolean;
  firstName: string;
  lastName: string;
  attendeeType: "STAFF" | "YOUTH";
  role: string;
  classLevel: ClubClassLevel | null;
  /** What the form said, when it isn't a known class level. */
  classText: string;
  reportedAge: number | null;
};

export type ImportInvite = {
  key: string;
  include: boolean;
  role: "DIRECTOR" | "DEPUTY";
  name: string;
  email: string;
};

export type ClubImportDraft = {
  sourceKey: string;
  entryId: string;
  clubYear: string;
  submittedOn: string;
  churchName: string;
  clubName: string;
  invites: ImportInvite[];
  people: ImportPerson[];
  approxPathfinders: string;
};

const entrySchema = z.object({
  id: z.union([z.number(), z.string()]),
  form_id: z.union([z.number(), z.string()]).optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  response: z.record(z.string(), z.unknown()),
});

const text = (value: unknown, max = 120) => (typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "");

function rows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => text(cell, 200)));
}

/** "Jane Q Example" → first "Jane Q", last "Example". One word stays a first name. */
export function splitName(fullName: string) {
  const words = text(fullName, 160).split(" ").filter(Boolean);
  if (words.length <= 1) return { firstName: words[0] ?? "", lastName: "" };
  return { firstName: words.slice(0, -1).join(" ").slice(0, 80), lastName: words[words.length - 1].slice(0, 80) };
}

const classAliases: Record<string, ClubClassLevel> = {
  friend: "FRIEND",
  companion: "COMPANION",
  explorer: "EXPLORER",
  ranger: "RANGER",
  voyager: "VOYAGER",
  guide: "GUIDE",
  tlt: "TLT",
  teenleadershiptraining: "TLT",
  masterguide: "MASTER_GUIDE",
  mg: "MASTER_GUIDE",
};

export function classLevelFrom(value: string): ClubClassLevel | null {
  return classAliases[value.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

export function ageFrom(value: string) {
  const match = /^\s*(\d{1,2})\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(value: unknown) {
  const email = text(value, 254).toLowerCase();
  return emailPattern.test(email) ? email : "";
}

/** "Albany SDA Church" → "Albany". Used to match churches and name the club. */
export function churchStem(name: string) {
  return text(name, 160)
    .toLowerCase()
    .replace(/seventh[\s-]*day\s+adventist/g, " ")
    .replace(/\b(sda|church|company|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function defaultClubName(churchName: string) {
  const stem = text(churchName, 160)
    .replace(/seventh[\s-]*day\s+adventist/gi, " ")
    .replace(/\b(SDA|Church)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stem ? `${stem} Pathfinders` : "";
}

function person(key: string, name: string, fields: Partial<ImportPerson>): ImportPerson {
  const { firstName, lastName } = splitName(name);
  return {
    key,
    include: Boolean(firstName),
    firstName,
    lastName,
    attendeeType: "YOUTH",
    role: "",
    classLevel: null,
    classText: "",
    reportedAge: null,
    ...fields,
  };
}

function draftFrom(entry: z.infer<typeof entrySchema>): ClubImportDraft {
  const response = entry.response;
  const churches = Array.isArray(response.multi_select) ? response.multi_select.map((value) => text(value, 160)) : [text(response.multi_select, 160)];
  const churchName = churches.find(Boolean) ?? "";
  const submitted = entry.created_at ? new Date(entry.created_at.replace(" ", "T") + "Z") : new Date();
  const submittedOn = Number.isNaN(submitted.getTime()) ? "" : submitted.toISOString().slice(0, 10);
  const clubYear = clubYearFor(Number.isNaN(submitted.getTime()) ? new Date() : submitted);
  const entryId = String(entry.id);

  const invites: ImportInvite[] = [];
  const people: ImportPerson[] = [];
  for (const [prefix, role, label] of [["leader", "DIRECTOR", "Director"], ["co_leader", "DEPUTY", "Deputy director"]] as const) {
    const name = text(response[`${prefix}_name`], 160);
    const email = cleanEmail(response[`${prefix}_email`]);
    if (!name && !email) continue;
    invites.push({ key: `${prefix}-invite`, include: Boolean(email), role, name, email });
    if (name) people.push(person(prefix, name, { attendeeType: "STAFF", role: label }));
  }
  // Other staff: [name, address, cell, email, child protection]. Only the name is kept.
  rows(response.other_assistants).forEach((row, index) => {
    if (row[0]) people.push(person(`staff-${index}`, row[0], { attendeeType: "STAFF", role: "Staff" }));
  });
  // Pathfinders: [name, age, class].
  rows(response.repeater_container).forEach((row, index) => {
    if (!row[0]) return;
    const classText = row[2] ?? "";
    people.push(person(`pathfinder-${index}`, row[0], {
      attendeeType: "YOUTH",
      role: "Pathfinder",
      reportedAge: ageFrom(row[1] ?? ""),
      classLevel: classLevelFrom(classText),
      classText: classLevelFrom(classText) ? "" : classText.slice(0, 40),
    }));
  });

  return {
    sourceKey: `form-${CLUB_IMPORT_FORM_ID}:${entryId}`,
    entryId,
    clubYear,
    submittedOn,
    churchName,
    clubName: defaultClubName(churchName),
    invites,
    people,
    approxPathfinders: text(response.approx_pathfinders, 10),
  };
}

export class ClubImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClubImportParseError";
  }
}

/** The export's entries as drafts. Trashed entries and other forms are skipped. */
export function parseClubRegistrationExport(input: unknown) {
  if (!Array.isArray(input)) {
    throw new ClubImportParseError("That file isn't a Fluent Forms entries export. Export the form's entries as JSON and try again.");
  }
  const drafts: ClubImportDraft[] = [];
  let skipped = 0;
  for (const raw of input) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const entry = parsed.data;
    if (entry.form_id !== undefined && String(entry.form_id) !== CLUB_IMPORT_FORM_ID) {
      skipped += 1;
      continue;
    }
    if (entry.status === "trashed") {
      skipped += 1;
      continue;
    }
    drafts.push(draftFrom(entry));
  }
  if (drafts.length === 0) {
    throw new ClubImportParseError("No club registrations were found in that file. Check that it is the entries export of form 89.");
  }
  return { drafts, skipped };
}

/** The ExternalIdentity scope: one import per club per club year. */
export function importScope(clubYear: string) {
  return `form-${CLUB_IMPORT_FORM_ID}:${clubYear}`;
}
