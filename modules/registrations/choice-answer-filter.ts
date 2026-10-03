import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { isLinkedToBlockedField } from "@/modules/forms/field-dependency-walk";
import { SENSITIVE_FIELD_STEMS } from "@/modules/forms/sensitive-fields";
import type { RegistrationRecord } from "@/modules/registrations/repository";

/**
 * Find and list registrations by the answer to a structured choice question
 * (a drop-down, radio group or multi-select), for example "Meal preference =
 * Vegetarian" (#739). It is generic over the form definition: nothing here
 * knows about meals.
 *
 * Privacy: only choice answers can be filtered. Free text never can, and
 * neither can a question that reads as health, dietary need, allergy, custody
 * or otherwise private (see `modules/forms/sensitive-fields.ts`), sits in such
 * a section, or is wired by `conditional` / `optionalWhen` to such a question.
 * This runs on the server; the question id from the URL is looked up in the
 * set of filterable questions and ignored when it is not in it.
 *
 * Eligibility is decided per form version. A registration is read for a
 * question only when ITS OWN definition has that question as filterable, so a
 * later version that reuses a key for free text is never read as a choice.
 * Only values the question offers are ever shown or counted by name; any other
 * stored value falls into an "other" bucket that carries no text.
 */

export const CHOICE_FILTER_QUESTION_PARAM = "answerQuestion";
export const CHOICE_FILTER_VALUE_PARAM = "answerValue";

/** Active registrations only: the people actually expected at the event. */
const COUNTED_STATUSES: ReadonlySet<string> = new Set(["SUBMITTED", "CONFIRMED"]);

const FILTERABLE_TYPES: ReadonlySet<string> = new Set(["SELECT", "RADIO", "MULTISELECT"]);

/**
 * Stems that name a dietary choice an ordinary meal drop-down offers
 * ("Vegetarian", "Vegan", "Gluten-free"). The shared sensitive list treats
 * them as sensitive anywhere, which is right for free text and for a
 * question's own wording. They are skipped only when reading a choice's
 * option text, so an everyday meal menu stays filterable. "Nut free" and
 * "lactose" are allergy signals and stay blocked. This is a heuristic: an
 * explicit staff-set "filterable" flag on a question is a future decision.
 */
const MEAL_MENU_STEMS: ReadonlySet<string> = new Set(["vegetarian", "vegan", "gluten"]);

const QUESTION_PATTERN = new RegExp(`\\b(?:${SENSITIVE_FIELD_STEMS.join("|")})`, "i");
const OPTION_PATTERN = new RegExp(
  `\\b(?:${SENSITIVE_FIELD_STEMS.filter((stem) => !MEAL_MENU_STEMS.has(stem)).join("|")})`,
  "i",
);

function words(text: string) {
  return text.replaceAll("_", " ");
}

export type ChoiceQuestion = {
  /** Unique across scopes: `${scope}:${key}`. This is what the URL carries. */
  id: string;
  key: string;
  label: string;
  scope: "REGISTRATION" | "ATTENDEE";
  multi: boolean;
  /** The choices staff can pick, in form order, with the label people see. */
  choices: Array<{ value: string; label: string }>;
};

type FilterableFieldShape = Pick<RegistrationFormField, "type" | "key" | "label" | "helpText" | "options" | "optionLabels" | "optionSource">;

/** The field's own wording (or its section's title) reads as sensitive, or it is the payment-method field. */
function isBlockedByItself(field: FilterableFieldShape, paymentMethodFieldKey: string | null | undefined, sectionTitle: string) {
  if (paymentMethodFieldKey && field.key === paymentMethodFieldKey) return true;
  if ([words(field.key), field.label, field.helpText ?? "", sectionTitle].some((text) => QUESTION_PATTERN.test(text))) return true;
  return [...field.options, ...Object.values(field.optionLabels ?? {})].some((text) => OPTION_PATTERN.test(words(text)));
}

/**
 * Whether a question may be filtered on at all. Internal, and `context` (the
 * form's fields and section titles) is required, so no caller can skip the
 * check that rules out a question when anything in its `conditional` /
 * `optionalWhen` chain, in either direction, is blocked.
 */
function isFilterableChoiceField(
  field: RegistrationFormField,
  paymentMethodFieldKey: string | null | undefined,
  context: { allFields: readonly RegistrationFormField[]; sectionTitleOf: (field: RegistrationFormField) => string },
) {
  if (!FILTERABLE_TYPES.has(field.type)) return false;
  // Directory-sourced lists (churches, clubs) are not a short menu of choices.
  if (field.optionSource) return false;
  if (field.options.length === 0) return false;
  const titleOf = context.sectionTitleOf;
  if (isBlockedByItself(field, paymentMethodFieldKey, titleOf(field))) return false;
  if (isLinkedToBlockedField(field, context.allFields, (other) => isBlockedByItself(other, paymentMethodFieldKey, titleOf(other)))) return false;
  return true;
}

const definitionCache = new WeakMap<object, Map<string, ChoiceQuestion>>();

/** The filterable questions of ONE form definition, by id. Empty when it does not parse. */
function questionsFromDefinition(definition: Record<string, unknown>): Map<string, ChoiceQuestion> {
  const cached = definitionCache.get(definition);
  if (cached) return cached;
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  const questions = new Map<string, ChoiceQuestion>();
  if (parsed.success) {
    const paymentKey = parsed.data.payment?.paymentMethodFieldKey ?? null;
    const allFields = parsed.data.sections.flatMap((section) => section.fields);
    const titles = new Map<RegistrationFormField, string>();
    for (const section of parsed.data.sections) for (const field of section.fields) titles.set(field, section.title);
    const context = { allFields, sectionTitleOf: (field: RegistrationFormField) => titles.get(field) ?? "" };
    for (const field of allFields) {
      if (!isFilterableChoiceField(field, paymentKey, context)) continue;
      const id = `${field.scope}:${field.key}`;
      questions.set(id, {
        id,
        key: field.key,
        label: field.label,
        scope: field.scope === "ATTENDEE" ? "ATTENDEE" : "REGISTRATION",
        multi: field.type === "MULTISELECT",
        choices: field.options.map((option) => ({ value: option, label: field.optionLabels?.[option] ?? option })),
      });
    }
  }
  definitionCache.set(definition, questions);
  return questions;
}

/** Every filterable question across the event's registration forms, deduplicated. */
export function listChoiceQuestions(registrations: readonly RegistrationRecord[]): ChoiceQuestion[] {
  const byId = new Map<string, ChoiceQuestion>();
  for (const registration of registrations) {
    const definition = registration.publicSubmission?.definition;
    if (!definition) continue;
    for (const question of questionsFromDefinition(definition).values()) {
      const existing = byId.get(question.id);
      if (!existing) {
        byId.set(question.id, { ...question, choices: [...question.choices] });
        continue;
      }
      // A later form version may add a choice; keep the union, in first-seen order.
      for (const choice of question.choices) {
        if (!existing.choices.some((known) => known.value === choice.value)) existing.choices.push(choice);
      }
    }
  }
  return [...byId.values()];
}

function answerValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (typeof raw === "string" && raw.trim() !== "") return [raw];
  return [];
}

export type ChoiceMatch = {
  registrationId: string;
  confirmationCode: string;
  /** Attendee name for a per-attendee question; the account holder for a registration-wide one. */
  personName: string;
  attendeeId: string | null;
  /** What the person chose, as the form labels it. */
  value: string;
};

function labelFor(question: ChoiceQuestion, value: string) {
  return question.choices.find((choice) => choice.value === value)?.label ?? value;
}

type PersonAnswer = {
  attendeeId: string | null;
  personName: string;
  /** Values the question offers. */
  known: string[];
  /** True when something else was stored (never shown). */
  hasOther: boolean;
};

/**
 * Every person's answer to the question on one registration, or null when the
 * registration's own form version does not have it as a filterable question
 * (it was free text there, sensitive, or absent): such a registration is not
 * read at all, so it is neither listed nor counted as "no answer".
 */
function answersOf(registration: RegistrationRecord, question: ChoiceQuestion): PersonAnswer[] | null {
  const definition = registration.publicSubmission?.definition;
  if (!definition || !questionsFromDefinition(definition).has(question.id)) return null;
  const offered = new Set(question.choices.map((choice) => choice.value));
  const read = (attendeeId: string | null, personName: string, raw: unknown): PersonAnswer => {
    const values = answerValues(raw);
    const known = [...new Set(values.filter((value) => offered.has(value)))];
    return { attendeeId, personName, known, hasOther: values.some((value) => !offered.has(value)) };
  };
  if (question.scope === "REGISTRATION") {
    const name = `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`.trim();
    return [read(null, name, registration.publicSubmission?.responses?.[question.key])];
  }
  return registration.attendees.map((attendee, index) => {
    const current = Object.keys(attendee.responses ?? {}).length > 0
      ? attendee.responses
      : registration.publicSubmission?.attendeeResponses[index] ?? {};
    return read(attendee.id, `${attendee.firstName} ${attendee.lastName}`.trim(), (current as Record<string, unknown>)[question.key]);
  });
}

function countedRegistrations(registrations: readonly RegistrationRecord[]) {
  return registrations.filter((registration) => COUNTED_STATUSES.has(registration.status));
}

export type ChoiceCount = { value: string; label: string; count: number };

/**
 * People (or registrations, for a registration-wide question) per offered
 * choice, how many stored something the question does not offer (`other`,
 * never shown by name), and how many gave no answer among registrations whose
 * form has the question. Built from the same rows `matchesForChoice` returns,
 * so a count always equals the list it opens.
 */
export function choiceAnswerCounts(registrations: readonly RegistrationRecord[], question: ChoiceQuestion) {
  const counts = new Map<string, number>(question.choices.map((choice) => [choice.value, 0]));
  let unanswered = 0;
  let other = 0;
  for (const registration of countedRegistrations(registrations)) {
    for (const answer of answersOf(registration, question) ?? []) {
      if (answer.known.length === 0 && !answer.hasOther) unanswered += 1;
      if (answer.hasOther) other += 1;
      for (const value of answer.known) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const choices: ChoiceCount[] = [...counts.entries()].map(([value, count]) => ({ value, label: labelFor(question, value), count }));
  return { choices, unanswered, other };
}

/** The people who chose `value`, one row each. */
export function matchesForChoice(registrations: readonly RegistrationRecord[], question: ChoiceQuestion, value: string): ChoiceMatch[] {
  const matches: ChoiceMatch[] = [];
  for (const registration of countedRegistrations(registrations)) {
    for (const answer of answersOf(registration, question) ?? []) {
      if (!answer.known.includes(value)) continue;
      matches.push({
        registrationId: registration.id,
        confirmationCode: registration.confirmationCode,
        personName: answer.personName,
        attendeeId: answer.attendeeId,
        value: labelFor(question, value),
      });
    }
  }
  return matches;
}

export type ChoiceFilterRequest = { question: string | null | undefined; value: string | null | undefined };

export type ResolvedChoiceFilter = {
  question: ChoiceQuestion;
  /** The chosen value, or null while only the question is picked (counts show, no list yet). */
  value: string | null;
};

/**
 * Turns the URL's question id and value into a filter, or null. A question
 * that is not in the filterable set (free text, sensitive, unknown) resolves
 * to null however the URL is edited. An unknown value for a real question
 * is treated as no value picked.
 */
export function resolveChoiceFilter(
  registrations: readonly RegistrationRecord[],
  request: ChoiceFilterRequest,
): ResolvedChoiceFilter | null {
  if (!request.question) return null;
  const question = listChoiceQuestions(registrations).find((candidate) => candidate.id === request.question);
  if (!question) return null;
  const known = Boolean(request.value) && question.choices.some((choice) => choice.value === request.value);
  return { question, value: known ? (request.value as string) : null };
}

/** Registrations holding at least one match, in their original order. */
export function filterRegistrationsByChoice(registrations: readonly RegistrationRecord[], filter: ResolvedChoiceFilter) {
  if (!filter.value) return [...registrations];
  const ids = new Set(matchesForChoice(registrations, filter.question, filter.value).map((match) => match.registrationId));
  return registrations.filter((registration) => ids.has(registration.id));
}

export const CHOICE_EXPORT_HEADER = [
  "Confirmation code",
  "Person",
  "Account holder",
  "Email",
  "Status",
  "Question",
  "Chosen value",
] as const;

/**
 * CSV rows (for `toCsv`) for a filtered list: one row per person in the list
 * the page shows, so the file and the screen always agree. Only the account
 * holder's contact email is included, as in the general registrations export.
 */
export function choiceExportRows(
  registrations: readonly RegistrationRecord[],
  filter: ResolvedChoiceFilter & { value: string },
): Array<Array<string | number>> {
  const byId = new Map(registrations.map((registration) => [registration.id, registration]));
  const rows: Array<Array<string | number>> = [[...CHOICE_EXPORT_HEADER]];
  for (const match of matchesForChoice(registrations, filter.question, filter.value)) {
    const registration = byId.get(match.registrationId)!;
    rows.push([
      match.confirmationCode,
      match.personName,
      `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`.trim(),
      registration.accountHolder.email,
      registration.status,
      filter.question.label,
      match.value,
    ]);
  }
  return rows;
}
