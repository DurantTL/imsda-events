import { z } from "zod";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { formatAddressDisplay, isPlainAddressObject, sanitizeAddressInput } from "@/modules/forms/address";
import {
  isFieldVisible,
  registrationFormDefinitionSchema,
  validateTestResponses,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";

/**
 * Pure rules for club forms (#610): the template record, splitting answers
 * into plain and sensitive halves, validation on the registration-form
 * validator, and who may do what. Nothing here reads the database, so the
 * rules can be tested without one.
 */

export const CLUB_FORM_LINK_DEFAULT_DAYS = 14;
export const CLUB_FORM_LINK_MIN_DAYS = 1;
export const CLUB_FORM_LINK_MAX_DAYS = 30;
/** What a viewer without access to sensitive answers sees in their place. */
export const RESTRICTED_LABEL = "Restricted";
/** The largest answers payload accepted, in bytes of JSON. */
export const CLUB_FORM_MAX_ANSWERS_BYTES = 200_000;

export const clubFormPrintLayouts = ["STANDARD", "PASSENGER_LIST"] as const;
export type ClubFormPrintLayout = typeof clubFormPrintLayouts[number];

export const sectionNotesSchema = z.record(z.string(), z.array(z.string().trim().min(1).max(2000)).max(20));

export type ClubFormTemplateRecord = {
  id: string;
  key: string;
  name: string;
  description: string;
  version: number;
  definition: RegistrationFormDefinition;
  sectionNotes: Record<string, string[]>;
  sensitiveFieldKeys: string[];
  /**
   * The birth-date class of sensitive field (ADR 0005 Addendum A): a subset of
   * `sensitiveFieldKeys`. Only the club's own director and deputies and system
   * administrators may read these; Event Admins and Area Coordinators see
   * "Restricted" even though Event Admins may read the other sensitive answers.
   */
  birthDateFieldKeys: string[];
  staffOnlyFieldKeys: string[];
  printLayout: ClubFormPrintLayout;
  enabled: boolean;
};

export type ClubFormTemplateSpec = Pick<
  ClubFormTemplateRecord,
  "definition" | "sectionNotes" | "sensitiveFieldKeys" | "birthDateFieldKeys" | "staffOnlyFieldKeys"
>;

export function allFields(definition: RegistrationFormDefinition): RegistrationFormField[] {
  return definition.sections.flatMap((section) => section.fields);
}

/**
 * Problems with a template's own configuration: sensitive, staff-only and
 * note keys that name nothing, or a field marked both. Empty for a valid one.
 */
export function templateSpecProblems(spec: ClubFormTemplateSpec): string[] {
  const problems: string[] = [];
  const keys = new Set(allFields(spec.definition).map((field) => field.key));
  const sectionIds = new Set(spec.definition.sections.map((section) => section.id));
  for (const key of spec.sensitiveFieldKeys) {
    if (!keys.has(key)) problems.push(`Sensitive field ${key} is not in the form.`);
  }
  for (const key of spec.birthDateFieldKeys) {
    if (!keys.has(key)) problems.push(`Birth-date field ${key} is not in the form.`);
    if (!spec.sensitiveFieldKeys.includes(key)) problems.push(`Birth-date field ${key} must also be a sensitive field.`);
  }
  for (const key of spec.staffOnlyFieldKeys) {
    if (!keys.has(key)) problems.push(`Staff-only field ${key} is not in the form.`);
    if (spec.sensitiveFieldKeys.includes(key)) problems.push(`Field ${key} cannot be both staff-only and sensitive.`);
  }
  for (const id of Object.keys(spec.sectionNotes)) {
    if (!sectionIds.has(id)) problems.push(`Notes name section ${id}, which is not in the form.`);
  }
  return problems;
}

/** Reads a stored template row into a validated record; throws when its definition is not valid. */
export function parseClubFormTemplate(row: {
  id: string;
  key: string;
  name: string;
  description: string;
  version: number;
  definition: unknown;
  sectionNotes: unknown;
  sensitiveFieldKeys: string[];
  birthDateFieldKeys: string[];
  staffOnlyFieldKeys: string[];
  printLayout: string;
  enabled: boolean;
}): ClubFormTemplateRecord {
  const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === row.key);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    version: row.version,
    definition: registrationFormDefinitionSchema.parse(row.definition),
    sectionNotes: sectionNotesSchema.parse(row.sectionNotes ?? {}),
    // Whichever of the stored row and the code's seed says a key is sensitive wins, so a deploy that
    // has not been synced yet can only ever restrict more, never less.
    sensitiveFieldKeys: unionKeys(row.sensitiveFieldKeys, seed?.sensitiveFieldKeys),
    birthDateFieldKeys: unionKeys(row.birthDateFieldKeys, seed?.birthDateFieldKeys),
    staffOnlyFieldKeys: row.staffOnlyFieldKeys,
    printLayout: row.printLayout === "PASSENGER_LIST" ? "PASSENGER_LIST" : "STANDARD",
    enabled: row.enabled,
  };
}

/**
 * The definition a private-link filler sees: staff-only (office-use) fields
 * removed, and any section left empty removed with them.
 */
export function definitionForLink(template: Pick<ClubFormTemplateRecord, "definition" | "staffOnlyFieldKeys">): RegistrationFormDefinition {
  const hidden = new Set(template.staffOnlyFieldKeys);
  if (hidden.size === 0) return template.definition;
  return {
    ...template.definition,
    sections: template.definition.sections
      .map((section) => ({ ...section, fields: section.fields.filter((field) => !hidden.has(field.key)) }))
      .filter((section) => section.fields.length > 0),
  };
}

/** Trims text, drops empty answers, and keeps only the value shapes the field types use. */
function cleanValue(field: RegistrationFormField, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (field.type === "ADDRESS") {
    if (!isPlainAddressObject(value)) return value;
    const address = sanitizeAddressInput(value);
    return Object.keys(address).length === 0 ? undefined : address;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === "string" ? item.trim() : item)).filter((item) => item !== "");
    return items.length === 0 ? undefined : items;
  }
  return value;
}

/**
 * Keeps only answers to fields that exist, are visible under the form's
 * "show only when" rules, and are not in `excludeKeys`. Anything else a
 * client sends is dropped, so a hidden or staff-only field can never be
 * written by hand-crafting a request.
 */
export function sanitizeClubFormAnswers(
  definition: RegistrationFormDefinition,
  raw: Record<string, unknown>,
  excludeKeys: readonly string[] = [],
): Record<string, unknown> {
  const excluded = new Set(excludeKeys);
  const cleaned: Record<string, unknown> = {};
  for (const field of allFields(definition)) {
    if (excluded.has(field.key)) continue;
    const value = cleanValue(field, raw[field.key]);
    if (value !== undefined) cleaned[field.key] = value;
  }
  // Second pass: visibility depends on the other answers, so it is judged on the cleaned set.
  const visible: Record<string, unknown> = {};
  for (const field of allFields(definition)) {
    if (!(field.key in cleaned)) continue;
    if (isFieldVisible(field, cleaned)) visible[field.key] = cleaned[field.key];
  }
  return visible;
}

export type ClubFormIssue = { key: string; message: string };

/**
 * Validates answers with the registration-form validator, so the builder's
 * field types, choices, dates and required rules apply unchanged. Messages
 * name a field's label and never echo an answer. A draft skips "required".
 */
export function validateClubFormAnswers(
  definition: RegistrationFormDefinition,
  answers: Record<string, unknown>,
  options: { draft?: boolean; excludeKeys?: readonly string[] } = {},
): ClubFormIssue[] {
  const fieldKeys = allFields(definition).map((field) => field.key);
  const result = validateTestResponses(definition, answers, {}, undefined, {
    ignoreAvailability: true,
    ignoredFieldKeys: options.excludeKeys ?? [],
    optionalFieldKeys: options.draft ? fieldKeys : [],
  });
  return result.issues.map((issue) => ({ key: issue.key, message: issue.message }));
}

/** Splits cleaned answers into the plain half and the sensitive half. */
export function splitAnswers(
  template: Pick<ClubFormTemplateRecord, "sensitiveFieldKeys">,
  answers: Record<string, unknown>,
) {
  const sensitiveKeys = new Set(template.sensitiveFieldKeys);
  const plain: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    (sensitiveKeys.has(key) ? sensitive : plain)[key] = value;
  }
  return { plain, sensitive };
}

/** A short text form of one answer, for lists, print pages and CSV. */
export function formatClubFormAnswer(field: RegistrationFormField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (field.type === "CHECKBOX") return value === true ? "Yes" : "No";
  if (field.type === "ADDRESS") return formatAddressDisplay(value);
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

/** A person-ish label for a submission's list row when nobody typed one. */
const SUBJECT_KEYS = ["full_name", "child_name", "certified_name", "passenger_1_name", "contact_name"] as const;

export function deriveSubjectName(answers: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) {
    const value = answers[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return "";
}

export function clampLinkDays(days: number | undefined) {
  if (days === undefined || !Number.isFinite(days)) return CLUB_FORM_LINK_DEFAULT_DAYS;
  return Math.min(CLUB_FORM_LINK_MAX_DAYS, Math.max(CLUB_FORM_LINK_MIN_DAYS, Math.trunc(days)));
}

export type ClubFormEmailDelivery = "QUEUED" | "SENT" | "DELIVERED" | "NOT_DELIVERED" | "UNKNOWN";

/**
 * What a director sees for the link's email: still going out, on its way,
 * delivered, or not delivered (out of retries, a bounce, a complaint or a
 * suppressed address). Not delivered means the link was withdrawn; send a new one.
 */
export function clubFormEmailDelivery(message: {
  status: string;
  providerDeliveryStatus: string | null;
}): ClubFormEmailDelivery {
  if (["FAILED", "SUPPRESSED", "CANCELLED"].includes(message.status)) return "NOT_DELIVERED";
  if (["BOUNCED", "FAILED", "COMPLAINED", "SUPPRESSED"].includes(message.providerDeliveryStatus ?? "")) return "NOT_DELIVERED";
  if (message.providerDeliveryStatus === "DELIVERED") return "DELIVERED";
  if (message.status === "SENT" || message.providerDeliveryStatus) return "SENT";
  if (message.status === "PENDING" || message.status === "PROCESSING") return "QUEUED";
  return "UNKNOWN";
}

export type ClubFormLinkState ="OPEN" | "USED" | "REVOKED" | "EXPIRED";

export function clubFormLinkState(link: { status: "OPEN" | "USED" | "REVOKED"; expiresAt: Date }, now: Date): ClubFormLinkState {
  if (link.status === "OPEN" && link.expiresAt <= now) return "EXPIRED";
  return link.status;
}

// ---------------------------------------------------------------------------
// Who may do what

/** Who is acting, for attribution and audit. Never both an account and a staff user. */
export type ClubFormActor =
  | { kind: "ATTENDEE"; accountId: string }
  | { kind: "STAFF_ACTING"; userId: string; actAsId: string };

/**
 * A resolved viewer. Built server-side from the session (see `access.ts`) and
 * passed to every repository function, which checks it again.
 *
 * - CLUB_LEADER: a director or deputy of `organizationId` (or a system
 *   administrator acting as that club's director). Fills in, sends links, and
 *   sees the club's files, including sensitive answers and birth dates.
 * - AREA_COORDINATOR: read-only over every club; every sensitive answer is
 *   "Restricted".
 * - STAFF: conference staff, which is only system administrators and Event
 *   Admins of a current event (Caleb, 2026-09-29). Read-only. They read the
 *   sensitive answers (health, conduct, physician, emergency contacts), but
 *   only a system administrator reads full birth dates (ADR 0005 Addendum A).
 */
export type ClubFormsViewer =
  | { kind: "CLUB_LEADER"; organizationId: string; actor: ClubFormActor }
  | { kind: "AREA_COORDINATOR"; actor: ClubFormActor }
  | { kind: "STAFF"; userId: string; systemAdmin: boolean };

export function viewerCanSeeClub(viewer: ClubFormsViewer, organizationId: string) {
  return viewer.kind !== "CLUB_LEADER" || viewer.organizationId === organizationId;
}

export function viewerCanWriteForClub(viewer: ClubFormsViewer, organizationId: string) {
  return viewer.kind === "CLUB_LEADER" && viewer.organizationId === organizationId;
}

/** Only the club's own leaders see drafts; everyone else sees submitted forms. */
export function viewerSeesDrafts(viewer: ClubFormsViewer) {
  return viewer.kind === "CLUB_LEADER";
}

/** Health, conduct, physician and emergency-contact answers (not birth dates). */
export function viewerCanRevealSensitive(viewer: ClubFormsViewer, organizationId: string) {
  if (viewer.kind === "CLUB_LEADER") return viewer.organizationId === organizationId;
  return viewer.kind === "STAFF";
}

/** Full birth dates (ADR 0005 Addendum A): the club's own leaders and system administrators only. */
export function viewerCanRevealBirthDates(viewer: ClubFormsViewer, organizationId: string) {
  if (viewer.kind === "CLUB_LEADER") return viewer.organizationId === organizationId;
  return viewer.kind === "STAFF" && viewer.systemAdmin;
}

/**
 * The sensitive keys a viewer may not read, shown as "Restricted": every one,
 * answered or not, so a blank tells nothing.
 */
export function restrictedFieldKeys(
  viewer: ClubFormsViewer,
  organizationId: string,
  template: Pick<ClubFormTemplateRecord, "sensitiveFieldKeys" | "birthDateFieldKeys">,
) {
  const birth = new Set(template.birthDateFieldKeys);
  const sensitive = viewerCanRevealSensitive(viewer, organizationId);
  const birthDates = viewerCanRevealBirthDates(viewer, organizationId);
  return template.sensitiveFieldKeys.filter((key) => (birth.has(key) ? !birthDates : !sensitive));
}

/** Only club directors and deputies use club forms; registrars and reporters do not. */
export function isClubFormsRole(role: string) {
  return role === "DIRECTOR" || role === "DEPUTY";
}

/** Audit fields that say who viewed, never what they saw. */
export function viewerAuditFields(viewer: ClubFormsViewer): {
  actorUserId?: string;
  metadata: { viewerKind: ClubFormsViewer["kind"]; actorAttendeeAccountId?: string; actAsId?: string };
} {
  if (viewer.kind === "STAFF") return { actorUserId: viewer.userId, metadata: { viewerKind: viewer.kind } };
  const { actor } = viewer;
  return actor.kind === "ATTENDEE"
    ? { metadata: { viewerKind: viewer.kind, actorAttendeeAccountId: actor.accountId } }
    : { actorUserId: actor.userId, metadata: { viewerKind: viewer.kind, actAsId: actor.actAsId } };
}

function unionKeys(stored: readonly string[], seed: readonly string[] = []) {
  return [...new Set([...stored, ...seed])];
}
