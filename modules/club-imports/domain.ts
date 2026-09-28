import { z } from "zod";
import { clubYearChoices, clubYearFor, rosterSectionOf, type ClubClassLevel } from "@/modules/club-rosters/domain";

export { clubYearChoices };

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
  /**
   * Staff pressed "Keep both" on someone who shares a name and roster section
   * with an earlier person in this registration (#541): import them anyway.
   */
  keepBoth: boolean;
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
  /** The club year the roster is imported into. Defaults to the current one at import time, not the submission date (#541). */
  clubYear: string;
  /** The club year the entry was submitted in, from `created_at`. Informational only. */
  submittedClubYear: string;
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

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
const NAME_PARTICLES = new Set(["de", "van", "von", "da", "del"]);

const AMBIGUOUS_SUFFIXES = new Set(["ii", "iv"]);
const isSuffix = (word: string) => NAME_SUFFIXES.has(word.toLowerCase().replace(/\./g, ""));
const isParticle = (word: string) => NAME_PARTICLES.has(word.toLowerCase());

/**
 * "Jane Q Example" → first "Jane Q", last "Example". One word stays a first
 * name. A suffix (Jr., Sr., II, III, IV) stays with the last name: "Chris
 * Faux Jr." → last "Faux Jr." (#541). A particle (de, de la, van, von, da,
 * del) joins the last name when another word follows it: "Ana de la Cruz" →
 * last "de la Cruz". The first name always keeps at least one word, so "Van
 * Example" stays first "Van". The preview shows the split and staff can edit it.
 */
export function splitName(fullName: string) {
  // "Chris Faux, Jr." → "Chris Faux Jr."
  const words = text(fullName, 160).replace(/,\s*(?=(?:jr|sr|ii|iii|iv)\.?(?:\s|$))/gi, " ").split(" ").filter(Boolean);
  if (words.length <= 1) return { firstName: words[0] ?? "", lastName: "" };
  let end = words.length;
  // A trailing suffix belongs to the word before it; with nothing before it but a first name, there is no last name to attach to.
  // "II" and "IV" are also surnames: "Kim Iv" keeps last name "Iv" rather than losing it.
  while (end > 1 && isSuffix(words[end - 1]) && !(end === 2 && AMBIGUOUS_SUFFIXES.has(words[end - 1].toLowerCase().replace(/\./g, "")))) end -= 1;
  if (end <= 1) return { firstName: words.join(" ").slice(0, 80), lastName: "" };
  let start = end - 1;
  // A capitalised "Van" in the middle of exactly three words is a middle name ("Tran Van Minh"), not a particle.
  const vietnameseVan = end === 3 && words[1] === "Van";
  if (start > 1 && isParticle(words[start - 1]) && !vietnameseVan) start -= 1;
  // "de la" is the one two-word particle.
  else if (start > 2 && words[start - 1].toLowerCase() === "la" && words[start - 2].toLowerCase() === "de") start -= 2;
  return { firstName: words.slice(0, start).join(" ").slice(0, 80), lastName: words.slice(start).join(" ").slice(0, 80) };
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
    keepBoth: false,
    ...fields,
  };
}

function draftFrom(entry: z.infer<typeof entrySchema>, now: Date): ClubImportDraft {
  const response = entry.response;
  const churches = Array.isArray(response.multi_select) ? response.multi_select.map((value) => text(value, 160)) : [text(response.multi_select, 160)];
  const churchName = churches.find(Boolean) ?? "";
  const submitted = entry.created_at ? new Date(entry.created_at.replace(" ", "T") + "Z") : new Date();
  const submittedOn = Number.isNaN(submitted.getTime()) ? "" : submitted.toISOString().slice(0, 10);
  // A registration for the coming year is often sent in August, before the
  // club year turns over in September. The roster it belongs to is the one
  // being worked on now, so the default is the current club year and the
  // submission's own year is only shown as a note (#541).
  const submittedClubYear = clubYearFor(Number.isNaN(submitted.getTime()) ? now : submitted);
  const clubYear = clubYearFor(now);
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
    submittedClubYear,
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
export function parseClubRegistrationExport(input: unknown, now = new Date()) {
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
    drafts.push(draftFrom(entry, now));
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

/** "form-89:2025-26" → "2025-26"; null for any other scope. */
export function scopeClubYear(providerScope: string) {
  const prefix = `form-${CLUB_IMPORT_FORM_ID}:`;
  const year = providerScope.startsWith(prefix) ? providerScope.slice(prefix.length) : "";
  return /^\d{4}-\d{2}$/.test(year) ? year : null;
}

/** Shown when the submission date falls in a different club year than the one chosen. */
export function submissionYearNote(draft: Pick<ClubImportDraft, "clubYear" | "submittedClubYear" | "submittedOn">) {
  if (!draft.submittedOn || draft.submittedClubYear === draft.clubYear) return "";
  return `Submitted ${draft.submittedOn}, which falls in the ${draft.submittedClubYear} club year. Importing into ${draft.clubYear}.`;
}

/** Why a person was not added; carried to the result screen so no skip is silent. */
export type ImportSkipReason = "ALREADY_ON_ROSTER" | "DUPLICATE_IN_REGISTRATION";

export function skipReasonLabel(reason: ImportSkipReason, clubYear: string) {
  return reason === "ALREADY_ON_ROSTER"
    ? `already on the roster for ${clubYear}`
    : "listed twice in this registration with the same name in the same section (if they are different people, add the second one on the roster)";
}

function nameKey(firstName: string, lastName: string) {
  // "Faux Jr." and "Faux Jr" (and "Faux, Jr.") are the same name.
  return `${firstName} ${lastName}`.trim().toLocaleLowerCase("en-US")
    .replace(/,/g, " ")
    .replace(/\b(jr|sr)\./g, "$1")
    .replace(/\s+/g, " ");
}

/**
 * Two people count as the same only when the full name AND the roster
 * section (`rosterSectionOf`) match: a parent on staff and a child in the
 * club who share a name are different people (#541).
 */
export function importPersonKey(person: { attendeeType: "STAFF" | "YOUTH" | "ADULT" | "UNDERAGE"; firstName: string; lastName: string }) {
  return `${rosterSectionOf(person.attendeeType)}|${nameKey(person.firstName, person.lastName)}`;
}

/**
 * The people in one registration that repeat an earlier included person's
 * name and section (#541), by `key`. Not added unless staff press "Keep
 * both": two different youths can share a name, and a copy-paste repeat
 * looks the same.
 */
export function inFileDuplicateKeys(people: Array<Pick<ImportPerson, "key" | "include" | "attendeeType" | "firstName" | "lastName">>) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const person of people) {
    if (!person.include || !person.firstName.trim()) continue;
    const key = importPersonKey(person);
    if (seen.has(key)) duplicates.add(person.key);
    else seen.add(key);
  }
  return duplicates;
}

/** An earlier import of this entry, by club year, as the preview knows it. */
export type ImportedYears = Record<string, { id: string; name: string }>;

export const MOVE_IMPORT_ACTION = "Move import to another year";

/**
 * What the preview says about earlier imports of this entry (#541).
 * `blocking` when it was imported for the chosen year. Otherwise a hint when
 * it was imported for another year only: importing again would create a
 * second copy of everyone, so the Move action is suggested instead.
 */
export function earlierImportNotice(importedYears: ImportedYears, clubYear: string) {
  const here = importedYears[clubYear];
  if (here) {
    return { blocking: true, clubId: here.id, message: `Already imported for ${clubYear}. To fix the year, use ${MOVE_IMPORT_ACTION}.` };
  }
  const [otherYear, other] = Object.entries(importedYears)[0] ?? [];
  if (!otherYear || !other) return null;
  return {
    blocking: false,
    clubId: other.id,
    message: `Already imported for ${otherYear}. Importing it again for ${clubYear} would add everyone a second time. To fix the year, use ${MOVE_IMPORT_ACTION} instead.`,
  };
}
