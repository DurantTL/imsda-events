import { z } from "zod";
import { clubClassLevelLabels, clubClassLevels, parseRosterBirthDateInput, type ClubClassLevel } from "@/modules/club-rosters/domain";
import { GUARDIAN_SLOTS, guardianEmailProblem, guardianPhoneProblem, type GuardianValues } from "@/modules/club-rosters/guardians-domain";
import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";

/**
 * The "Allow adding to the roster" setting of a club form template (#721), as
 * pure rules: the stored shape, the checks a mapping must pass before it is
 * saved or used, and how mapped answers become a pre-filled roster member.
 * Nothing here reads the database or a sealed value.
 *
 * What a mapping is: field keys of the form, one per roster field. It never
 * holds an answer. Protection rules (ADR 0005 Addendum A):
 *
 * - a birth-date field can only fill the roster's birth date, and the roster's
 *   birth date can only be filled from a birth-date field, so it stays sealed
 *   from the form to the roster;
 * - any other sensitive field cannot fill any roster field;
 * - health fields cannot be mapped at all. The encrypted Health Record (#611)
 *   is the only home for health information and is never fed from a form.
 */

const fieldKey = z.string().trim().min(1).max(60);

export const rosterMappingSchema = z.object({
  /** "Allow adding to the roster": off until an administrator turns it on for the form. */
  enabled: z.boolean(),
  /** Youth member or staff: the roster type the person is pre-filled as. */
  rosterType: z.enum(["YOUTH", "STAFF"]),
  fields: z.object({
    fullName: fieldKey.optional(),
    firstName: fieldKey.optional(),
    lastName: fieldKey.optional(),
    birthDate: fieldKey.optional(),
    gender: fieldKey.optional(),
    classLevel: fieldKey.optional(),
    role: fieldKey.optional(),
  }).strict(),
  /** Up to two guardian contacts. A slot may name a fixed relationship instead of a form field. */
  guardians: z.array(z.object({
    name: fieldKey.optional(),
    relationship: fieldKey.optional(),
    relationshipLabel: z.string().trim().max(60).optional(),
    email: fieldKey.optional(),
    phone: fieldKey.optional(),
  }).strict()).max(GUARDIAN_SLOTS).default([]),
}).strict();

export type RosterMapping = z.infer<typeof rosterMappingSchema>;

export type RosterMappingFieldTarget = keyof RosterMapping["fields"];

export const rosterTargetLabels: Record<RosterMappingFieldTarget, string> = {
  fullName: "Full name (split into first and last)",
  firstName: "First name",
  lastName: "Last name",
  birthDate: "Birth date (sealed)",
  gender: "Gender",
  classLevel: "Current class",
  role: "Role",
};

/** Targets in the order the builder shows them. */
export const rosterFieldTargets: readonly RosterMappingFieldTarget[] = ["fullName", "firstName", "lastName", "birthDate", "gender", "classLevel", "role"];

export const guardianMappingParts = ["name", "relationship", "email", "phone"] as const;
export type GuardianMappingPart = (typeof guardianMappingParts)[number];

type FieldType = RegistrationFormField["type"];

const textTypes: readonly FieldType[] = ["TEXT"];
const choiceOrText: readonly FieldType[] = ["SELECT", "RADIO", "TEXT"];
const allowedTypes: Record<RosterMappingFieldTarget, readonly FieldType[]> = {
  fullName: textTypes,
  firstName: textTypes,
  lastName: textTypes,
  birthDate: ["DATE"],
  gender: choiceOrText,
  classLevel: choiceOrText,
  role: textTypes,
};
const guardianTypes: Record<GuardianMappingPart, readonly FieldType[]> = {
  name: textTypes,
  relationship: textTypes,
  email: ["EMAIL", "TEXT"],
  phone: ["PHONE", "TEXT"],
};

/**
 * Health-like wording in a field's key, label or section title. A conservative
 * backstop for a field nobody flagged as sensitive: the roster is never a home
 * for health information, so such a field cannot be mapped even by mistake.
 */
const HEALTH_WORDS = /health|medical|medication|allerg|physician|doctor|diagnos|illness|sickness|injur|immuni[sz]|disabilit|dietary|diet\b|condition|insurance|surgery|asthma|diabet/i;

export function looksLikeHealthField(field: Pick<RegistrationFormField, "key" | "label">, sectionTitle = "") {
  return HEALTH_WORDS.test(`${field.key} ${field.label} ${sectionTitle}`);
}

export type RosterMappingSpec = {
  definition: RegistrationFormDefinition;
  sensitiveFieldKeys: readonly string[];
  birthDateFieldKeys: readonly string[];
  hiddenFieldKeys?: readonly string[];
};

/** Every (target, field key) pair of a mapping, for the checks and for the builder. */
export function mappedFieldKeys(mapping: RosterMapping): Array<{ target: string; fieldKey: string; label: string }> {
  const pairs: Array<{ target: string; fieldKey: string; label: string }> = [];
  for (const target of rosterFieldTargets) {
    const key = mapping.fields[target];
    if (key) pairs.push({ target, fieldKey: key, label: rosterTargetLabels[target] });
  }
  mapping.guardians.forEach((guardian, index) => {
    for (const part of guardianMappingParts) {
      const key = guardian[part];
      if (key) pairs.push({ target: `guardian${index + 1}.${part}`, fieldKey: key, label: `Guardian ${index + 1} ${part}` });
    }
  });
  return pairs;
}

/**
 * Why a mapping cannot be saved or used, in plain words. Messages name field
 * labels and roster fields, never an answer. Empty when the mapping is fine.
 * Completeness (a name and a birth date) is required only when `enabled`.
 */
export function rosterMappingProblems(mapping: RosterMapping, spec: RosterMappingSpec): string[] {
  const problems: string[] = [];
  const fields = new Map<string, { field: RegistrationFormField; sectionTitle: string }>();
  for (const section of spec.definition.sections) {
    for (const field of section.fields) fields.set(field.key, { field, sectionTitle: section.title });
  }
  const sensitive = new Set(spec.sensitiveFieldKeys);
  const birth = new Set(spec.birthDateFieldKeys);
  const hidden = new Set(spec.hiddenFieldKeys ?? []);
  const seen = new Map<string, string>();

  for (const { target, fieldKey, label } of mappedFieldKeys(mapping)) {
    const found = fields.get(fieldKey);
    if (!found) {
      problems.push(`Roster mapping: ${label} uses ${fieldKey}, which is not in the form.`);
      continue;
    }
    const { field, sectionTitle } = found;
    const name = field.label.trim() || field.key;
    const isBirthTarget = target === "birthDate";
    if (looksLikeHealthField(field, sectionTitle)) {
      problems.push(`Roster mapping: ${name} cannot be mapped. Health information never goes onto the roster; the Health Record is the place for it.`);
      continue;
    }
    if (isBirthTarget) {
      if (!birth.has(fieldKey)) problems.push(`Roster mapping: ${label} must come from a field marked as a birth date, so it stays sealed. ${name} is not one.`);
    } else if (birth.has(fieldKey)) {
      problems.push(`Roster mapping: ${name} is a birth-date field and can only fill the roster's birth date.`);
    } else if (sensitive.has(fieldKey)) {
      problems.push(`Roster mapping: ${name} is a sensitive field and cannot fill ${label.toLowerCase()}. Sensitive answers stay on the form.`);
    }
    const allowed = isBirthTarget
      ? allowedTypes.birthDate
      : target.startsWith("guardian")
        ? guardianTypes[target.split(".")[1] as GuardianMappingPart]
        : allowedTypes[target as RosterMappingFieldTarget];
    if (!allowed.includes(field.type)) problems.push(`Roster mapping: ${name} is the wrong kind of question for ${label.toLowerCase()}.`);
    if (hidden.has(fieldKey)) problems.push(`Roster mapping: ${name} is hidden from new forms, so it cannot fill ${label.toLowerCase()}.`);
    const earlier = seen.get(fieldKey);
    if (earlier) problems.push(`Roster mapping: ${name} is used for two roster fields (${earlier} and ${label.toLowerCase()}).`);
    else seen.set(fieldKey, label.toLowerCase());
  }

  const { fields: mapped } = mapping;
  if (mapped.fullName && (mapped.firstName || mapped.lastName)) {
    problems.push("Roster mapping: use either a full-name question or separate first and last name questions, not both.");
  }
  if (mapping.rosterType === "STAFF" && (mapped.classLevel || mapping.guardians.some((guardian) => guardianMappingParts.some((part) => guardian[part])))) {
    problems.push("Roster mapping: a staff roster member has no class or guardian contacts.");
  }
  for (const [index, guardian] of mapping.guardians.entries()) {
    if (guardian.relationship && guardian.relationshipLabel) {
      problems.push(`Roster mapping: guardian ${index + 1} has both a relationship question and a fixed relationship. Choose one.`);
    }
  }
  if (mapping.enabled) {
    const hasName = Boolean(mapped.fullName || (mapped.firstName && mapped.lastName));
    if (!hasName) problems.push("Roster mapping: choose the question that holds the person's name (a full name, or first and last name).");
    if (!mapped.birthDate) problems.push("Roster mapping: choose the birth-date question. The roster needs a birth date.");
  }
  return problems;
}

/** A stored value read leniently: the mapping when it parses, otherwise null. */
export function parseRosterMapping(raw: unknown): RosterMapping | null {
  if (raw === null || raw === undefined) return null;
  const parsed = rosterMappingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A mapping that is on and passes every check for this form, or null (the form then offers no "Add to roster"). */
export function usableRosterMapping(mapping: RosterMapping | null, spec: RosterMappingSpec): RosterMapping | null {
  if (!mapping || !mapping.enabled) return null;
  return rosterMappingProblems(mapping, spec).length === 0 ? mapping : null;
}

/** Drops mapped keys that no longer name a field, so a removed question never leaves a dangling mapping. */
export function mappingWithoutKey(mapping: RosterMapping | null, key: string): RosterMapping | null {
  if (!mapping) return mapping;
  const fields = Object.fromEntries(Object.entries(mapping.fields).filter(([, value]) => value !== key)) as RosterMapping["fields"];
  const guardians = mapping.guardians.map((guardian) => Object.fromEntries(Object.entries(guardian).filter(([, value]) => value !== key)) as RosterMapping["guardians"][number]);
  return { ...mapping, fields, guardians };
}

/** Follows a renamed question. */
export function mappingWithRenamedKey(mapping: RosterMapping | null, from: string, to: string): RosterMapping | null {
  if (!mapping) return mapping;
  const rename = <T extends Record<string, unknown>>(record: T) => Object.fromEntries(Object.entries(record).map(([part, value]) => [part, value === from ? to : value])) as T;
  return { ...mapping, fields: rename(mapping.fields), guardians: mapping.guardians.map((guardian) => rename(guardian)) };
}

// ---------------------------------------------------------------------------
// Pre-filling a roster member from mapped answers

export type RosterPrefill = {
  firstName: string;
  lastName: string;
  /** `YYYY-MM-DD`, or "" when the form had none the roster can read. */
  birthDate: string;
  attendeeType: "YOUTH" | "STAFF";
  role: string;
  classLevel: ClubClassLevel | null;
  gender: "FEMALE" | "MALE" | null;
  guardians: GuardianValues[];
};

/**
 * "Jordan Q. Sample" becomes first "Jordan Q.", last "Sample"; "Sample, Jordan"
 * becomes first "Jordan", last "Sample". A single word is a first name. The
 * director corrects anything the guess gets wrong on the review screen.
 */
export function splitFullName(value: string): { firstName: string; lastName: string } {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return { firstName: "", lastName: "" };
  if (cleaned.includes(",")) {
    const [last, ...rest] = cleaned.split(",");
    return { firstName: rest.join(" ").trim(), lastName: last.trim() };
  }
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { firstName: cleaned, lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function text(answers: Record<string, unknown>, key: string | undefined, max: number) {
  if (!key) return "";
  const value = answers[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function classLevelFrom(value: string): ClubClassLevel | null {
  const wanted = value.toLowerCase().replace(/[^a-z]/g, "");
  if (!wanted) return null;
  return clubClassLevels.find((level) => level.toLowerCase().replace(/_/g, "") === wanted
    || clubClassLevelLabels[level].toLowerCase().replace(/[^a-z]/g, "") === wanted) ?? null;
}

function genderFrom(value: string): "FEMALE" | "MALE" | null {
  const wanted = value.trim().toLowerCase();
  if (wanted === "female" || wanted === "f" || wanted === "girl") return "FEMALE";
  if (wanted === "male" || wanted === "m" || wanted === "boy") return "MALE";
  return null;
}

/**
 * The roster member a mapping pre-fills from a form's answers. Only mapped
 * keys are read, and a key the protection rules would refuse (health, or a
 * sensitive field that is not the birth date) is skipped here too, so a stale
 * mapping can never carry such an answer onto the roster. The birth date is
 * read only from a field marked as a birth date. Pure: the caller decides who
 * may open the (sealed) answers it passes in.
 */
export function rosterPrefillFromAnswers(
  mapping: RosterMapping,
  answers: Record<string, unknown>,
  spec: RosterMappingSpec,
): RosterPrefill {
  const sensitive = new Set(spec.sensitiveFieldKeys);
  const birth = new Set(spec.birthDateFieldKeys);
  const sections = new Map<string, string>();
  const fieldByKey = new Map<string, RegistrationFormField>();
  for (const section of spec.definition.sections) {
    for (const field of section.fields) {
      sections.set(field.key, section.title);
      fieldByKey.set(field.key, field);
    }
  }
  /** The answers this mapping may read for a plain roster field. */
  const plain = (key: string | undefined) => {
    if (!key || sensitive.has(key) || birth.has(key)) return undefined;
    const field = fieldByKey.get(key);
    if (!field || looksLikeHealthField(field, sections.get(key))) return undefined;
    return key;
  };
  const { fields } = mapping;
  const named = fields.fullName ? splitFullName(text(answers, plain(fields.fullName), 160)) : null;
  const firstName = (named ? named.firstName : text(answers, plain(fields.firstName), 80)).slice(0, 80);
  const lastName = (named ? named.lastName : text(answers, plain(fields.lastName), 80)).slice(0, 80);
  const birthKey = fields.birthDate && birth.has(fields.birthDate) ? fields.birthDate : undefined;
  const birthRaw = text(answers, birthKey, 20);
  const birthDate = birthRaw ? parseRosterBirthDateInput(birthRaw) ?? "" : "";
  const gender = genderFrom(text(answers, plain(fields.gender), 20));
  const classLevel = mapping.rosterType === "YOUTH" ? classLevelFrom(text(answers, plain(fields.classLevel), 40)) : null;
  const guardians: GuardianValues[] = Array.from({ length: GUARDIAN_SLOTS }, (_, index) => {
    const slot = mapping.rosterType === "YOUTH" ? mapping.guardians[index] : undefined;
    if (!slot) return { name: "", relationship: "", email: "", phone: "" };
    const name = text(answers, plain(slot.name), 120);
    const email = text(answers, plain(slot.email), 254);
    const phone = text(answers, plain(slot.phone), 40);
    const relationship = text(answers, plain(slot.relationship), 60) || (slot.relationshipLabel ?? "").slice(0, 60);
    // A fixed relationship alone is not a contact: a slot with nothing else filled in stays blank.
    if (!name && !email && !phone) return { name: "", relationship: "", email: "", phone: "" };
    return {
      name,
      relationship,
      // The review screen shows a bad value for the director to fix; it never reaches a write unchecked.
      email,
      phone,
    };
  });
  return {
    firstName,
    lastName,
    birthDate,
    attendeeType: mapping.rosterType,
    role: text(answers, plain(fields.role), 60),
    classLevel,
    gender,
    guardians,
  };
}

/** Whether any pre-filled guardian value would fail the roster's own checks, for a note on the review screen. */
export function guardianPrefillHasProblems(guardians: readonly GuardianValues[]) {
  return guardians.some((guardian) => guardianEmailProblem(guardian.email) || guardianPhoneProblem(guardian.phone));
}

/**
 * The questions the builder offers for one roster field: only those the
 * protection rules allow, so the safe choice is the only choice. The birth
 * date offers birth-date questions only; every other field offers plain
 * (non-sensitive, non-health, visible) questions of a fitting type.
 */
export function rosterMappingCandidates(
  target: RosterMappingFieldTarget | `guardian.${GuardianMappingPart}`,
  spec: RosterMappingSpec,
): RegistrationFormField[] {
  const sensitive = new Set(spec.sensitiveFieldKeys);
  const birth = new Set(spec.birthDateFieldKeys);
  const hidden = new Set(spec.hiddenFieldKeys ?? []);
  const types = target.startsWith("guardian.") ? guardianTypes[target.slice(9) as GuardianMappingPart] : allowedTypes[target as RosterMappingFieldTarget];
  const result: RegistrationFormField[] = [];
  for (const section of spec.definition.sections) {
    for (const field of section.fields) {
      if (hidden.has(field.key) || !types.includes(field.type) || looksLikeHealthField(field, section.title)) continue;
      if (target === "birthDate" ? !birth.has(field.key) : birth.has(field.key) || sensitive.has(field.key)) continue;
      result.push(field);
    }
  }
  return result;
}
