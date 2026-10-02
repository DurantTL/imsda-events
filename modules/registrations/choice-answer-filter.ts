import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
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
 * or otherwise private (see `modules/forms/sensitive-fields.ts`). This runs on
 * the server; the question id from the URL is looked up in the set of
 * filterable questions and ignored when it is not in it.
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
 * option text, so an everyday meal menu stays filterable while a question
 * that asks about allergies or medical needs, or has such an option, never is.
 */
const MEAL_MENU_STEMS: ReadonlySet<string> = new Set(["vegetarian", "vegan", "gluten", "lactose", "nut\\s*free"]);

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

/** Whether a question may be filtered on at all. */
export function isFilterableChoiceField(
  field: Pick<RegistrationFormField, "type" | "key" | "label" | "helpText" | "options" | "optionLabels" | "optionSource">,
  paymentMethodFieldKey?: string | null,
) {
  if (!FILTERABLE_TYPES.has(field.type)) return false;
  // Directory-sourced lists (churches, clubs) are not a short menu of choices.
  if (field.optionSource) return false;
  if (paymentMethodFieldKey && field.key === paymentMethodFieldKey) return false;
  if (field.options.length === 0) return false;
  if ([words(field.key), field.label, field.helpText ?? ""].some((text) => QUESTION_PATTERN.test(text))) return false;
  if ([...field.options, ...Object.values(field.optionLabels ?? {})].some((text) => OPTION_PATTERN.test(words(text)))) return false;
  return true;
}

const definitionCache = new WeakMap<object, ChoiceQuestion[]>();

function questionsFromDefinition(definition: Record<string, unknown>): ChoiceQuestion[] {
  const cached = definitionCache.get(definition);
  if (cached) return cached;
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  const questions: ChoiceQuestion[] = [];
  if (parsed.success) {
    const paymentKey = parsed.data.payment?.paymentMethodFieldKey ?? null;
    for (const section of parsed.data.sections) {
      for (const field of section.fields) {
        if (!isFilterableChoiceField(field, paymentKey)) continue;
        questions.push({
          id: `${field.scope}:${field.key}`,
          key: field.key,
          label: field.label,
          scope: field.scope === "ATTENDEE" ? "ATTENDEE" : "REGISTRATION",
          multi: field.type === "MULTISELECT",
          choices: field.options.map((option) => ({ value: option, label: field.optionLabels?.[option] ?? option })),
        });
      }
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
    for (const question of questionsFromDefinition(definition)) {
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

/** Every (person, chosen values) the question holds for one registration. */
function answersOf(registration: RegistrationRecord, question: ChoiceQuestion): Array<{ attendeeId: string | null; personName: string; values: string[] }> {
  if (question.scope === "REGISTRATION") {
    const name = `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`.trim();
    return [{
      attendeeId: null,
      personName: name,
      values: answerValues(registration.publicSubmission?.responses?.[question.key]),
    }];
  }
  return registration.attendees.map((attendee, index) => {
    const current = Object.keys(attendee.responses ?? {}).length > 0
      ? attendee.responses
      : registration.publicSubmission?.attendeeResponses[index] ?? {};
    return {
      attendeeId: attendee.id,
      personName: `${attendee.firstName} ${attendee.lastName}`.trim(),
      values: answerValues((current as Record<string, unknown>)[question.key]),
    };
  });
}

function countedRegistrations(registrations: readonly RegistrationRecord[]) {
  return registrations.filter((registration) => COUNTED_STATUSES.has(registration.status));
}

export type ChoiceCount = { value: string; label: string; count: number };

/**
 * People (or registrations, for a registration-wide question) per choice, plus
 * how many gave no answer. Built from the same rows `matchesForChoice`
 * returns, so a count always equals the list it opens.
 */
export function choiceAnswerCounts(registrations: readonly RegistrationRecord[], question: ChoiceQuestion) {
  const counts = new Map<string, number>(question.choices.map((choice) => [choice.value, 0]));
  let unanswered = 0;
  for (const registration of countedRegistrations(registrations)) {
    for (const answer of answersOf(registration, question)) {
      if (answer.values.length === 0) unanswered += 1;
      for (const value of answer.values) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const choices: ChoiceCount[] = [...counts.entries()].map(([value, count]) => ({ value, label: labelFor(question, value), count }));
  return { choices, unanswered };
}

/** The people who chose `value`, one row each. */
export function matchesForChoice(registrations: readonly RegistrationRecord[], question: ChoiceQuestion, value: string): ChoiceMatch[] {
  const matches: ChoiceMatch[] = [];
  for (const registration of countedRegistrations(registrations)) {
    for (const answer of answersOf(registration, question)) {
      if (!answer.values.includes(value)) continue;
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
