import {
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { resolveFieldOffer, sectionTitleLookup } from "@/modules/forms/field-flags";
import type { RegistrationRecord } from "@/modules/registrations/repository";

/**
 * Find and list registrations by the answer to a structured choice question
 * (a drop-down, radio group or multi-select), for example "Meal preference =
 * Vegetarian" (#739). It is generic over the form definition: nothing here
 * knows about meals.
 *
 * Which questions are offered is a staff decision made in the form builder
 * (#743): a question is offered only when it is flagged "Show as a filter"
 * (or, for a form saved before the flags existed, when #739 would have
 * offered it: see `modules/forms/field-flags.ts`) AND is a choice field with options (free text never can be, and neither can
 * a directory-sourced list or the payment-method field). A question that is
 * also "Sensitive", or that is wired by `conditional` / `optionalWhen` to a
 * sensitive question in either direction, is offered only to a viewer who
 * holds VIEW_SENSITIVE_DATA. Absent flags fall back to the read-time defaults
 * in `modules/forms/field-flags.ts`, so forms published before the flags
 * existed behave as they did. This runs on the server; the question id from
 * the URL is looked up in the set the viewer may filter on and ignored when
 * it is not in it.
 *
 * Eligibility is decided per form version. A registration is read for a
 * question only when ITS OWN definition has that question as filterable, so a
 * later version that reuses a key for free text is never read as a choice.
 * Only values the question offers are ever shown or counted by name; any other
 * stored value falls into an "other" bucket that carries no text.
 */

export const CHOICE_FILTER_QUESTION_PARAM = "answerQuestion";
export const CHOICE_FILTER_VALUE_PARAM = "answerValue";

/**
 * Reserved filter values for the two buckets that are not a real choice: people
 * with no answer, and people whose stored value the question does not offer.
 * They can never collide with a real choice: `questionsFromDefinition` drops
 * any option whose value equals one of these from `choices`, so such a stored
 * value counts as "other" like any value the question does not offer. They are
 * only honoured by `resolveChoiceFilter` for a question the viewer may filter on.
 */
export const CHOICE_FILTER_UNANSWERED = "__unanswered";
export const CHOICE_FILTER_OTHER = "__other";
export const CHOICE_FILTER_UNANSWERED_LABEL = "No answer";
export const CHOICE_FILTER_OTHER_LABEL = "Other / no longer offered";

function isReservedChoiceValue(value: string | null | undefined): value is string {
  return value === CHOICE_FILTER_UNANSWERED || value === CHOICE_FILTER_OTHER;
}

/** Active registrations only: the people actually expected at the event. */
const COUNTED_STATUSES: ReadonlySet<string> = new Set(["SUBMITTED", "CONFIRMED"]);

export type ChoiceQuestion = {
  /** Unique across scopes: `${scope}:${key}`. This is what the URL carries. */
  id: string;
  key: string;
  label: string;
  scope: "REGISTRATION" | "ATTENDEE";
  multi: boolean;
  /** The choices staff can pick, in form order, with the label people see. */
  choices: Array<{ value: string; label: string }>;
  /** Sensitive (flagged, or linked to a sensitive question): only VIEW_SENSITIVE_DATA holders may filter on it. */
  sensitive: boolean;
};

/** Who is asking. Required, so no caller can skip the sensitive check. */
export type ChoiceFilterViewer = { canViewSensitive: boolean };

/**
 * Whether a question is offered, and whether it is sensitive. Internal, and
 * `context` (the form's fields, section titles and payment key) is required,
 * so no caller can skip the check that treats a question as sensitive when
 * anything in its `conditional` / `optionalWhen` chain, in either direction,
 * is sensitive.
 */
function offeredQuestion(
  field: RegistrationFormField,
  context: {
    allFields: readonly RegistrationFormField[];
    sectionTitleOf: (field: RegistrationFormField) => string;
    paymentMethodFieldKey: string | null;
  },
): { sensitive: boolean } | null {
  // The same helper the form builder uses for its "Show as a filter" box.
  const offer = resolveFieldOffer(field, context);
  return offer.filterable ? { sensitive: offer.sensitive } : null;
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
    const context = { allFields, sectionTitleOf: sectionTitleLookup(parsed.data.sections), paymentMethodFieldKey: paymentKey };
    for (const field of allFields) {
      const offered = offeredQuestion(field, context);
      if (!offered) continue;
      const id = `${field.scope}:${field.key}`;
      questions.set(id, {
        id,
        key: field.key,
        label: field.label,
        scope: field.scope === "ATTENDEE" ? "ATTENDEE" : "REGISTRATION",
        multi: field.type === "MULTISELECT",
        choices: field.options.filter((option) => !isReservedChoiceValue(option)).map((option) => ({ value: option, label: field.optionLabels?.[option] ?? option })),
        sensitive: offered.sensitive,
      });
    }
  }
  definitionCache.set(definition, questions);
  return questions;
}

/**
 * Every question this viewer may filter on across the event's registration
 * forms, deduplicated. A question that is sensitive in any form version is
 * sensitive here, and is left out for a viewer without VIEW_SENSITIVE_DATA.
 */
export function listChoiceQuestions(registrations: readonly RegistrationRecord[], viewer: ChoiceFilterViewer): ChoiceQuestion[] {
  const byId = new Map<string, ChoiceQuestion>();
  for (const registration of registrations) {
    const definition = registration.publicSubmission?.definition;
    if (!definition) continue;
    for (const question of questionsFromDefinition(definition).values()) {
      const existing = byId.get(question.id);
      if (existing && question.sensitive) existing.sensitive = true;
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
  return [...byId.values()].filter((question) => viewer.canViewSensitive || !question.sensitive);
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
  // Reserved buckets are labelled generically; a stored "other" value is never named.
  if (value === CHOICE_FILTER_UNANSWERED) return CHOICE_FILTER_UNANSWERED_LABEL;
  if (value === CHOICE_FILTER_OTHER) return CHOICE_FILTER_OTHER_LABEL;
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
 * One attendee's answers by field key: the answers saved on the attendee, else
 * the ones from the original submission at the same position. The single
 * place this fallback lives, shared with the attendee listing.
 */
export function attendeeAnswerRecord(registration: RegistrationRecord, index: number): Record<string, unknown> {
  const attendee = registration.attendees[index];
  if (!attendee) return {};
  return Object.keys(attendee.responses ?? {}).length > 0
    ? attendee.responses
    : (registration.publicSubmission?.attendeeResponses[index] ?? {}) as Record<string, unknown>;
}

/**
 * Every person's answer to the question on one registration, or null when the
 * registration's own form version does not have it as a filterable question
 * (it was free text there, not flagged, or absent): such a registration is not
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
  return registration.attendees.map((attendee, index) => (
    read(attendee.id, `${attendee.firstName} ${attendee.lastName}`.trim(), attendeeAnswerRecord(registration, index)[question.key])
  ));
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

function answerMatches(answer: PersonAnswer, value: string) {
  if (value === CHOICE_FILTER_UNANSWERED) return answer.known.length === 0 && !answer.hasOther;
  if (value === CHOICE_FILTER_OTHER) return answer.hasOther;
  return answer.known.includes(value);
}

/** The people who chose `value` (or the reserved no-answer / other bucket), one row each. */
export function matchesForChoice(registrations: readonly RegistrationRecord[], question: ChoiceQuestion, value: string): ChoiceMatch[] {
  const matches: ChoiceMatch[] = [];
  for (const registration of countedRegistrations(registrations)) {
    for (const answer of answersOf(registration, question) ?? []) {
      if (!answerMatches(answer, value)) continue;
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
 * that is not in the set this viewer may filter on (not flagged, free text,
 * sensitive without VIEW_SENSITIVE_DATA, unknown) resolves
 * to null however the URL is edited. The reserved no-answer / other values are accepted only here, for a
 * real allowed question. An unknown value for a real question is treated as
 * no value picked.
 */
export function resolveChoiceFilter(
  registrations: readonly RegistrationRecord[],
  request: ChoiceFilterRequest,
  viewer: ChoiceFilterViewer,
): ResolvedChoiceFilter | null {
  if (!request.question) return null;
  const question = listChoiceQuestions(registrations, viewer).find((candidate) => candidate.id === request.question);
  if (!question) return null;
  const known = Boolean(request.value) && (isReservedChoiceValue(request.value) || question.choices.some((choice) => choice.value === request.value));
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
