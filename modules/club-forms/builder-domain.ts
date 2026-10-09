import { z } from "zod";
import {
  allFields,
  clubFormPrintLayouts,
  sectionNotesSchema,
  templateSpecProblems,
  type ClubFormTemplateRecord,
} from "@/modules/club-forms/domain";
import { rosterMappingProblems, rosterMappingSchema } from "@/modules/club-forms/roster-mapping";
import { fieldDisplayLabel, formFieldScopes, formFieldTypes, registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";

/**
 * Pure rules for the club form builder (#712): the draft shape, the checks a
 * draft must pass before it is saved or published, and the protection rules
 * for sensitive and birth-date fields. Nothing here reads the database, so
 * the rules can be tested without one. Issues are keyed for the builder:
 * `field:<field id>`, `section:<section id>`, `removed:<field key>` or
 * `template`. No message ever carries an answer.
 */

export type BuilderIssue = { key: string; message: string };

export const clubFormDraftSchema = z.object({
  name: z.string().trim().min(2, "Give the form a name.").max(120),
  description: z.string().trim().max(300).default(""),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  printLayout: z.enum(clubFormPrintLayouts).default("STANDARD"),
  definition: registrationFormDefinitionSchema,
  sectionNotes: sectionNotesSchema.default({}),
  sensitiveFieldKeys: z.array(z.string().max(60)).max(400).default([]),
  birthDateFieldKeys: z.array(z.string().max(60)).max(400).default([]),
  staffOnlyFieldKeys: z.array(z.string().max(60)).max(400).default([]),
  hiddenFieldKeys: z.array(z.string().max(60)).max(400).default([]),
  /** "Allow adding to the roster" (#721): null until set; a seeded template then uses the code's (off) mapping. */
  rosterMapping: rosterMappingSchema.nullable().default(null),
}).strict();

export type ClubFormDraftSpec = z.infer<typeof clubFormDraftSchema>;

/** The largest draft stored, in bytes of JSON. */
export const CLUB_FORM_DRAFT_MAX_BYTES = 400_000;

const looseText = z.string().max(5000);
const looseField = z.object({
  id: z.string().min(1).max(80),
  key: looseText,
  label: looseText,
  helpText: looseText.default(""),
  type: z.enum(formFieldTypes),
  scope: z.enum(formFieldScopes),
  required: z.boolean(),
  options: z.array(looseText).max(400).default([]),
}).passthrough();
const looseKeys = z.array(z.string().max(120)).max(800).default([]);

/**
 * What an unfinished draft must still be (#712): enough structure for the
 * builder to open it, nothing more. Saves accept anything that parses here
 * and report the full check's problems as warnings; publish runs the full
 * check (`clubFormDraftSchema` and the protection rules) under the lock.
 */
export const clubFormDraftShapeSchema = z.object({
  name: looseText,
  description: looseText.default(""),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  printLayout: z.enum(clubFormPrintLayouts).default("STANDARD"),
  definition: z.object({
    title: looseText,
    description: looseText.default(""),
    confirmationMessage: looseText.default(""),
    sections: z.array(z.object({
      id: z.string().min(1).max(80),
      title: looseText,
      description: looseText.default(""),
      fields: z.array(looseField).max(100),
    }).passthrough()).max(40),
  }).passthrough(),
  sectionNotes: z.record(z.string(), z.array(looseText).max(40)).default({}),
  sensitiveFieldKeys: looseKeys,
  birthDateFieldKeys: looseKeys,
  staffOnlyFieldKeys: looseKeys,
  hiddenFieldKeys: looseKeys,
  rosterMapping: z.record(z.string(), z.unknown()).nullable().default(null),
}).strict();

/** Reads a stored or incoming draft for the builder to show; null when it is not even structurally a draft. */
export function readDraftShape(raw: unknown): ClubFormDraftSpec | null {
  if (!raw || typeof raw !== "object") return null;
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > CLUB_FORM_DRAFT_MAX_BYTES) return null;
  const parsed = clubFormDraftShapeSchema.safeParse(raw);
  return parsed.success ? (parsed.data as unknown as ClubFormDraftSpec) : null;
}

/** What earlier published versions fix in place for a template. */
export type ClubFormProtectionHistory = {
  /** Keys that were sensitive in any published version (and in the code's seed). */
  everSensitiveKeys: readonly string[];
  /** Keys that were birth-date fields in any published version. */
  everBirthDateKeys: readonly string[];
  /** Any submission, draft or submitted, exists for the template. */
  hasSubmissions: boolean;
  /** The field keys in the version being replaced: only deleting one of these is a deletion. */
  publishedFieldKeys: readonly string[];
};

export const NO_PROTECTION_HISTORY: ClubFormProtectionHistory = { everSensitiveKeys: [], everBirthDateKeys: [], hasSubmissions: false, publishedFieldKeys: [] };

const sectionIdKey = (id: string) => `section:${id}`;
const fieldIdKey = (id: string) => `field:${id}`;

function readId(value: unknown): string | null {
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

/** Turns a schema path into the builder's issue key, using the ids in the raw input. */
function keyForPath(raw: unknown, path: ReadonlyArray<PropertyKey>): string {
  if (path[0] === "rosterMapping") return "rosterMapping";
  if (path[0] === "definition" && path[1] === "sections" && typeof path[2] === "number") {
    const sections = (raw as { definition?: { sections?: unknown[] } } | null)?.definition?.sections;
    const section = Array.isArray(sections) ? sections[path[2]] : undefined;
    if (path[3] === "fields" && typeof path[4] === "number") {
      const fields = (section as { fields?: unknown[] } | undefined)?.fields;
      const fieldId = Array.isArray(fields) ? readId(fields[path[4]]) : null;
      if (fieldId) return fieldIdKey(fieldId);
    }
    const sectionId = readId(section);
    if (sectionId) return sectionIdKey(sectionId);
  }
  return "template";
}

function describeField(field: { label: string; key: string; group?: string }) {
  const label = field.label.trim();
  return label ? fieldDisplayLabel({ label, group: field.group }) : field.key;
}

/** Checks that apply only to club forms: no pricing, no attendee roster, no payment. */
function clubFormRestrictionIssues(definition: RegistrationFormDefinition): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  if (definition.attendeeRoster) issues.push({ key: "template", message: "Club forms do not use an attendee roster." });
  if (definition.payment) issues.push({ key: "template", message: "Club forms do not take payment." });
  if (definition.requireAtLeastOne) issues.push({ key: "template", message: "Club forms do not use an \"at least one\" rule." });
  for (const section of definition.sections) {
    for (const field of section.fields) {
      const key = fieldIdKey(field.id);
      const name = describeField(field);
      if (field.type === "CALCULATED") issues.push({ key, message: `${name}: calculated fields are not available on club forms.` });
      if (field.scope !== "REGISTRATION") issues.push({ key, message: `${name}: club forms ask each question once, not per attendee.` });
      if (
        field.priceCents !== undefined || field.choicePricesCents || field.latePricing || field.creditCentsPerUnit !== undefined
        || field.capUnitsAtAttendeeCount || field.choiceLimits || (field.availabilityMode && field.availabilityMode !== "NONE")
      ) {
        issues.push({ key, message: `${name}: pricing and capacity limits are not available on club forms.` });
      }
      if (field.optionSource === "ATTENDEE_TYPES") issues.push({ key, message: `${name}: the attendee-type list is not available on club forms.` });
    }
  }
  return issues;
}

/** Flags and notes must name real, consistent fields. Mirrors `templateSpecProblems`, but keyed to the field. */
function flagIssues(spec: ClubFormDraftSpec): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const byKey = new Map(allFields(spec.definition).map((field) => [field.key, field]));
  const sectionIds = new Set(spec.definition.sections.map((section) => section.id));
  const sensitive = new Set(spec.sensitiveFieldKeys);
  const hidden = new Set(spec.hiddenFieldKeys);
  const where = (key: string) => {
    const field = byKey.get(key);
    return field ? { key: fieldIdKey(field.id), name: describeField(field) } : { key: "template", name: key };
  };
  for (const key of spec.sensitiveFieldKeys) {
    if (!byKey.has(key)) issues.push({ key: "template", message: `Sensitive field ${key} is not in the form.` });
  }
  for (const key of spec.birthDateFieldKeys) {
    const at = where(key);
    if (!byKey.has(key)) issues.push({ key: "template", message: `Birth-date field ${key} is not in the form.` });
    else if (!sensitive.has(key)) issues.push({ key: at.key, message: `${at.name}: a birth-date field must also be marked sensitive.` });
  }
  for (const key of spec.staffOnlyFieldKeys) {
    const at = where(key);
    if (!byKey.has(key)) issues.push({ key: "template", message: `Staff-only field ${key} is not in the form.` });
    else if (sensitive.has(key)) issues.push({ key: at.key, message: `${at.name}: a field cannot be both staff-only and sensitive.` });
  }
  for (const key of spec.hiddenFieldKeys) {
    if (!byKey.has(key)) issues.push({ key: "template", message: `Hidden field ${key} is not in the form.` });
  }
  for (const id of Object.keys(spec.sectionNotes)) {
    if (!sectionIds.has(id)) issues.push({ key: "template", message: `Notes name section ${id}, which is not in the form.` });
  }
  if (spec.hiddenFieldKeys.length > 0 && allFields(spec.definition).every((field) => hidden.has(field.key))) {
    issues.push({ key: "template", message: "At least one field must stay visible." });
  }
  // A visible field must not depend on a hidden one: it could never show.
  for (const field of allFields(spec.definition)) {
    if (hidden.has(field.key)) continue;
    for (const rule of [field.conditional, field.optionalWhen]) {
      if (rule && hidden.has(rule.fieldKey)) {
        issues.push({ key: fieldIdKey(field.id), message: `${describeField(field)}: it depends on a hidden field. Unhide that field or remove the rule.` });
      }
    }
  }
  return issues;
}

/** The roster mapping's own checks (#721), keyed `rosterMapping` so the builder shows them beside the setting. */
function rosterMappingIssues(spec: ClubFormDraftSpec): BuilderIssue[] {
  if (!spec.rosterMapping) return [];
  return rosterMappingProblems(spec.rosterMapping, spec).map((message) => ({ key: "rosterMapping", message }));
}

/**
 * The sensitive-flag protection rules, enforced on the server at save and at
 * publish. A field that was sensitive (or a birth date) in any published
 * version keeps that flag, and cannot be deleted while submissions exist
 * (hide it instead), so sealed answers are never exposed or orphaned.
 */
export function protectionIssues(spec: ClubFormDraftSpec, history: ClubFormProtectionHistory): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const byKey = new Map(allFields(spec.definition).map((field) => [field.key, field]));
  const sensitive = new Set(spec.sensitiveFieldKeys);
  const birth = new Set(spec.birthDateFieldKeys);
  const published = new Set(history.publishedFieldKeys);
  const check = (keys: readonly string[], kept: ReadonlySet<string>, flag: string) => {
    for (const key of keys) {
      const field = byKey.get(key);
      if (field) {
        if (!kept.has(key)) {
          issues.push({
            key: fieldIdKey(field.id),
            message: `${describeField(field)}: it was a ${flag} field in a published version, so it keeps that setting. Hide the field instead.`,
          });
        }
      } else if (history.hasSubmissions && published.has(key)) {
        issues.push({
          key: `removed:${key}`,
          message: `The ${flag} field ${key} cannot be deleted while forms have been filled in. Keep it and hide it from new forms instead.`,
        });
      }
    }
  };
  check(history.everBirthDateKeys, birth, "birth-date");
  check(history.everSensitiveKeys, sensitive, "sensitive");
  return issues;
}

export type DraftCheck =
  | { ok: true; spec: ClubFormDraftSpec; issues: [] }
  | { ok: false; spec: null; issues: BuilderIssue[] };

/**
 * Validates a draft the way publishing does: the shared registration-form
 * schema (unique keys, valid options, ranked-choice limits and so on), the
 * club form restrictions, the flag rules and the protection rules.
 */
export function checkClubFormDraft(raw: unknown, history: ClubFormProtectionHistory): DraftCheck {
  const parsed = clubFormDraftSchema.safeParse(raw);
  if (!parsed.success) {
    const seen = new Set<string>();
    const issues: BuilderIssue[] = [];
    for (const issue of parsed.error.issues) {
      const key = keyForPath(raw, issue.path);
      const id = `${key}|${issue.message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      issues.push({ key, message: issue.message });
    }
    return { ok: false, spec: null, issues };
  }
  const spec = parsed.data;
  const issues = [
    ...clubFormRestrictionIssues(spec.definition),
    ...flagIssues(spec),
    ...rosterMappingIssues(spec),
    ...protectionIssues(spec, history),
  ];
  if (issues.length === 0) {
    // Anything the shared spec check still finds is reported on the form as a whole (its roster mapping is checked above).
    for (const message of templateSpecProblems({ ...spec, rosterMapping: null })) issues.push({ key: "template", message });
  }
  return issues.length === 0 ? { ok: true, spec, issues: [] } : { ok: false, spec: null, issues };
}

/** The keys that become sensitive with this draft and so need existing answers sealed. */
export function newlySensitiveKeys(draft: Pick<ClubFormDraftSpec, "sensitiveFieldKeys">, publishedSensitiveKeys: readonly string[]) {
  const published = new Set(publishedSensitiveKeys);
  return draft.sensitiveFieldKeys.filter((key) => !published.has(key));
}

/** The draft's starting point: the published version as a spec. */
export function specFromRecord(record: Pick<
  ClubFormTemplateRecord,
  "name" | "description" | "definition" | "sectionNotes" | "sensitiveFieldKeys" | "birthDateFieldKeys" | "staffOnlyFieldKeys" | "hiddenFieldKeys" | "printLayout"
> & { sortOrder: number; rosterMapping?: ClubFormTemplateRecord["rosterMapping"] }): ClubFormDraftSpec {
  // The record's sensitive keys include the code seed's, which may name a field since removed.
  const present = new Set(allFields(record.definition).map((field) => field.key));
  const kept = (keys: readonly string[]) => keys.filter((key) => present.has(key));
  return {
    name: record.name,
    description: record.description,
    sortOrder: record.sortOrder,
    printLayout: record.printLayout,
    definition: record.definition,
    sectionNotes: record.sectionNotes,
    sensitiveFieldKeys: kept(record.sensitiveFieldKeys),
    birthDateFieldKeys: kept(record.birthDateFieldKeys),
    staffOnlyFieldKeys: kept(record.staffOnlyFieldKeys),
    hiddenFieldKeys: kept(record.hiddenFieldKeys),
    rosterMapping: record.rosterMapping ?? null,
  };
}

/** A blank form: one section with one text field. */
export function blankClubFormSpec(name: string): ClubFormDraftSpec {
  return {
    name,
    description: "",
    sortOrder: 100,
    printLayout: "STANDARD",
    definition: {
      title: name.length >= 3 ? name : `${name} form`,
      description: "",
      confirmationMessage: "Thank you. Your form has been received.",
      sections: [{
        id: "section_main",
        title: "Details",
        description: "",
        fields: [{ id: "field_name", key: "full_name", label: "Full name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] }],
      }],
    },
    sectionNotes: {},
    sensitiveFieldKeys: [],
    birthDateFieldKeys: [],
    staffOnlyFieldKeys: [],
    hiddenFieldKeys: [],
    rosterMapping: null,
  };
}

/**
 * A copy of a published spec for a new template: hidden fields are dropped
 * (the copy has no submissions to protect), with their flags and any section
 * they leave empty.
 */
export function copySpec(source: ClubFormDraftSpec, name: string): ClubFormDraftSpec {
  const hidden = new Set(source.hiddenFieldKeys);
  const sections = source.definition.sections
    .map((section) => ({ ...section, fields: section.fields.filter((field) => !hidden.has(field.key)) }))
    .filter((section) => section.fields.length > 0);
  const kept = new Set(sections.flatMap((section) => section.fields.map((field) => field.key)));
  const sectionIds = new Set(sections.map((section) => section.id));
  const keepKeys = (keys: readonly string[]) => keys.filter((key) => kept.has(key));
  return {
    ...source,
    name,
    definition: { ...source.definition, title: name.length >= 3 ? name : source.definition.title, sections },
    sectionNotes: Object.fromEntries(Object.entries(source.sectionNotes).filter(([id]) => sectionIds.has(id))),
    sensitiveFieldKeys: keepKeys(source.sensitiveFieldKeys),
    birthDateFieldKeys: keepKeys(source.birthDateFieldKeys),
    staffOnlyFieldKeys: keepKeys(source.staffOnlyFieldKeys),
    hiddenFieldKeys: [],
    // A copy starts without "Add to roster": whoever copies a form chooses that again for the new one.
    rosterMapping: null,
  };
}

/** A URL-safe template key from a name: lowercase letters, numbers and underscores. */
export function templateKeyFromName(name: string) {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return slug.length >= 2 ? slug : "club_form";
}

export const createTemplateSchema = z.object({
  name: z.string().trim().min(2, "Give the form a name.").max(120),
  copyFromKey: z.string().trim().min(1).max(80).optional(),
}).strict();

export const saveDraftSchema = z.object({
  draft: z.unknown(),
  /** The `draftUpdatedAt` the editor loaded (null when there was no draft), so a stale second tab is refused. */
  expectedDraftUpdatedAt: z.string().max(40).nullable().optional(),
  /** The published version the editor started from. */
  baseVersion: z.number().int().min(1),
}).strict();

export const publishSchema = z.object({
  baseVersion: z.number().int().min(1),
}).strict();
