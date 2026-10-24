import { isBirthDateField, isFieldVisible, normalizeTypedAnswers, validateTestResponses, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";
import { isLinkedToBlockedField } from "@/modules/forms/field-dependency-walk";
import { isFieldSensitive, isHealthTypeField, sectionTitleLookup } from "@/modules/forms/field-flags";
import { mealTicketBinding } from "@/modules/meals/domain";
import { visibilityControllerKeys } from "@/modules/forms/visibility-rule";

/**
 * The event's own attendee questions on the staff link form (#1027). Pure rules shared by the server (which decides) and the page
 * (which only asks what the server says to ask).
 *
 * A staff, pastor or volunteer registration is free, every meal is covered ("Covered (staff)"), and lodging is blocked for
 * staff (the office assigns rooms). So the link form asks the event's attendee-level questions EXCEPT those that:
 *
 * - carry a price or a credit, or are automatic fees (nothing is charged);
 * - choose a meal (a meal ticket quantity, or a meal preference): the conference covers every meal;
 * - are about lodging, housing or nights (staff never request lodging through a link);
 * - are health-type or flagged sensitive: health and accommodation answers are medical data, which stays with the existing
 *   health-record process and is never collected through a personal link;
 * - repeat what the link form already knows (the person's name, age and attendee type), or need machinery the link doesn't have
 *   (a recorded acknowledgment, the attendee-type picker);
 * - only apply when one of the questions left out is answered a certain way.
 *
 * Registration-level questions (contact, church, payment) are not asked: they belong to the registrant's own purchase, not to a
 * personal invitation. Each attendee-level question is asked of everyone in the party, because the event asks it of everyone.
 */

const NAME_KEYS: ReadonlySet<string> = new Set(["first_name", "last_name", "full_name", "name", "attendee_name", "guest_name"]);
const AGE_KEYS: ReadonlySet<string> = new Set(["attendee_age", "age", "guest_age"]);
const TYPE_KEYS: ReadonlySet<string> = new Set(["attendee_type", "guest_type"]);

/** Words that make a question about eating a meal (the conference covers every meal). */
const MEAL_PATTERN = /(^|[^a-z])(meals?|breakfasts?|lunch(es)?|suppers?|dinners?)([^a-z]|$)/i;
/** Words that make a question about where someone sleeps. Staff are housed by the office, never by a link. */
const LODGING_PATTERN = /\b(hous(e[sd]?|ing)|lodg(e[sd]?|ing)|dorms?|dormitor(y|ies)|cabins?|camp[\s_-]?sites?|campers?|\brv\b|tents?|trailers?|roommates?|bunks?|\bbeds?\b|\bnights?\b|accommodations?|first[\s_-]?floor|rooming)\b/i;

function priced(field: RegistrationFormField) {
  return field.type === "CALCULATED"
    || field.priceCents !== undefined
    || field.choicePricesCents !== undefined
    || field.latePricing !== undefined
    || field.creditCentsPerUnit !== undefined;
}

/** Health-type wording (the field's own group heading included), a sensitive flag, or a birth date: never asked through a link. */
function isMedicalField(field: RegistrationFormField, sectionTitle: string) {
  return isHealthTypeField(field, `${sectionTitle} ${field.group ?? ""}`) || isFieldSensitive(field, { sectionTitle }) || isBirthDateField(field);
}

/** Why a question is left off the link form, or null when it is asked. */
export function staffQuestionExclusion(field: RegistrationFormField, sectionTitle = ""): string | null {
  if (field.scope !== "ATTENDEE") return "registration-level";
  if (priced(field)) return "priced";
  if (mealTicketBinding(field.key) || MEAL_PATTERN.test(`${field.key.replaceAll("_", " ")} ${field.label}`)) return "meal";
  if (LODGING_PATTERN.test(`${field.key.replaceAll("_", " ")} ${field.label} ${sectionTitle}`)) return "lodging";
  // A limited-places choice claims inventory when it is answered; a link registration reserves nothing.
  if (field.availabilityMode === "CAPACITY") return "capacity-limited";
  if (NAME_KEYS.has(field.key) || AGE_KEYS.has(field.key) || TYPE_KEYS.has(field.key) || field.optionSource === "ATTENDEE_TYPES") return "already-known";
  // An address answer is a structured object, and a directory-sourced list (churches, clubs) is read from the directory, not the form.
  if (field.type === "ACKNOWLEDGMENT" || field.type === "ADDRESS" || field.autoDate || field.optionSource) return "unsupported";
  // An explicit "not sensitive" flag can only ever add exclusions here: health-type wording and birth dates stay off the form.
  if (isMedicalField(field, sectionTitle)) return "sensitive";
  return null;
}

export type StaffQuestion = Pick<
  RegistrationFormField,
  "id" | "key" | "label" | "helpText" | "placeholder" | "type" | "required" | "options" | "optionLabels" | "minSelections" | "maxSelections" | "conditional" | "conditionalGroup" | "optionalWhen" | "group" | "ageBounds"
>;

/** The form's questions the link form asks, in the form's order. */
export function staffEventQuestions(definition: RegistrationFormDefinition | null): RegistrationFormField[] {
  if (!definition) return [];
  const sectionTitleOf = sectionTitleLookup(definition.sections);
  const all = definition.sections.flatMap((section) => section.fields);
  const left = new Set<string>();
  for (const field of all) {
    if (staffQuestionExclusion(field, sectionTitleOf(field))) left.add(field.key);
  }
  // A neutral question wired to a medical one, in either direction (a Yes/No whose "Yes" opens a medical question), would give
  // that answer away: it is left out too. The same linkage check the answer filter uses.
  for (const field of all) {
    if (!left.has(field.key) && isLinkedToBlockedField(field, all, (other) => isMedicalField(other, sectionTitleOf(other)))) left.add(field.key);
  }
  // A question that depends on one left out is left out too (its answer could never be given), however deeply it is chained.
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of all) {
      if (left.has(field.key)) continue;
      const dependsOn = [...visibilityControllerKeys(field), field.optionalWhen?.fieldKey].filter((key): key is string => Boolean(key));
      // A question that depends on a registration-level answer can't be asked either: the link form has none.
      if (dependsOn.some((key) => left.has(key) || !all.some((candidate) => candidate.key === key && !left.has(candidate.key)))) {
        left.add(field.key);
        changed = true;
      }
    }
  }
  return all.filter((field) => !left.has(field.key));
}

/** What the page needs to ask one question: no prices, limits or anything the person has no use for. */
export function toStaffQuestion(field: RegistrationFormField): StaffQuestion {
  return {
    id: field.id,
    key: field.key,
    label: field.label,
    helpText: field.helpText,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    type: field.type,
    required: field.required,
    options: field.options,
    ...(field.optionLabels ? { optionLabels: field.optionLabels } : {}),
    ...(field.minSelections !== undefined ? { minSelections: field.minSelections } : {}),
    ...(field.maxSelections !== undefined ? { maxSelections: field.maxSelections } : {}),
    ...(field.conditional ? { conditional: field.conditional } : {}),
    ...(field.conditionalGroup ? { conditionalGroup: field.conditionalGroup } : {}),
    ...(field.optionalWhen ? { optionalWhen: field.optionalWhen } : {}),
    ...(field.group ? { group: field.group } : {}),
    ...(field.ageBounds ? { ageBounds: field.ageBounds } : {}),
  };
}

export type PartyAnswerResult = {
  /** One answer set per person in the party, in party order, holding only visible, asked questions. */
  answers: Array<Record<string, unknown>>;
  problems: string[];
};

/**
 * Checks the answers the form sent, one set per person in the party, against the event's own definition: required questions,
 * the field types and the choices. Answers to anything not asked (including a priced, meal or lodging question) are dropped, so a
 * crafted request can't write them. Never trusts what the page decided was visible.
 */
export function checkPartyAnswers(
  definition: RegistrationFormDefinition | null,
  sent: ReadonlyArray<Record<string, unknown>>,
  partySize: number,
  /** Who each answer set is for, in party order ("You", "Spouse", "Child 1"), so a problem names the person. */
  roles: readonly string[] = [],
): PartyAnswerResult {
  const questions = staffEventQuestions(definition);
  if (!definition || questions.length === 0) return { answers: Array.from({ length: partySize }, () => ({})), problems: [] };
  const asked = new Set(questions.map((field) => field.key));
  const ignored = definition.sections.flatMap((section) => section.fields).filter((field) => !asked.has(field.key)).map((field) => field.key);
  const answers: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  for (let index = 0; index < partySize; index += 1) {
    const raw = sent[index] ?? {};
    const picked: Record<string, unknown> = {};
    for (const field of questions) {
      if (Object.prototype.hasOwnProperty.call(raw, field.key)) picked[field.key] = raw[field.key];
    }
    const result = validateTestResponses(definition, picked, {}, "ATTENDEE", { ignoredFieldKeys: ignored, ignoreAvailability: true });
    for (const issue of result.issues) problems.push(partySize > 1 ? `${roles[index] ?? `Person ${index + 1}`}: ${issue.message}` : issue.message);
    const visible: Record<string, unknown> = {};
    for (const field of questions) {
      if (!isFieldVisible(field, picked)) continue;
      const value = picked[field.key];
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      visible[field.key] = value;
    }
    answers.push(normalizeTypedAnswers(definition, visible));
  }
  return { answers, problems };
}
