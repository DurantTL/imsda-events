import type { RegistrationFormField } from "@/modules/forms/definition";
import { isLinkedToBlockedField } from "@/modules/forms/field-dependency-walk";
import { SENSITIVE_FIELD_STEMS } from "@/modules/forms/sensitive-fields";

/**
 * Per-field "Show as a filter" and "Sensitive" flags (#743).
 *
 * The flags live on the field in the form definition JSON (`filterable`,
 * `sensitive`), so they are versioned with the form version and need no
 * database column or migration.
 *
 * Read-time defaults, applied only when a flag is ABSENT (every form saved
 * before the flags existed, and any field staff has not touched). They keep
 * #739 parity for published forms: a published form behaves after deploy
 * exactly as it did before, and a NEW filter needs an explicit tick.
 *
 * - `sensitive` defaults to true for health-type fields, decided by the
 *   codebase's shared health/medical/allergy/insurance word list
 *   (`SENSITIVE_FIELD_STEMS`) read from the field's key, label, help text,
 *   section title and choice text.
 * - `filterable` defaults to true ONLY for a field #739 would have offered:
 *   a choice field (drop-down, radio group or multi-select) with options that
 *   is not health-type, not the payment-method field, not directory-sourced,
 *   and not linked (by `conditional` / `optionalWhen`, in either direction) to
 *   a sensitive field or to the payment-method field. The link check needs the
 *   whole form, so `resolveFieldFlags` gives the field's own default and
 *   `resolveFieldOffer` adds the link check; the answer filter and the form
 *   builder both use `resolveFieldOffer`, so they cannot disagree. Fields #739
 *   offered stay offered by default, which includes gender, childcare and
 *   good-conduct award questions. Minor-status and housing questions that are
 *   linked to a sensitive question are not offered. A NEW filter needs an
 *   explicit tick.
 *
 * The vegetarian / vegan / gluten carve-out below is part of that legacy
 * default only: choice text such as "Vegetarian" does not make a menu field
 * health-type, so the live Women's Retreat meal field keeps working without
 * anyone re-saving the form. An explicit true or false always wins over the
 * default. This is a read-time default, not a data migration: nothing stored
 * is rewritten (except that the builder writes an explicit `sensitive: true`
 * for a health-type field the first time a form is saved).
 */
const MEAL_MENU_STEMS: ReadonlySet<string> = new Set(["vegetarian", "vegan", "gluten"]);

function stemsPattern(skip: (stem: string) => boolean) {
  return new RegExp(`\\b(?:${SENSITIVE_FIELD_STEMS.filter((stem) => !skip(stem)).join("|")})`, "i");
}

// Wording of a key, label or section title.
const WORDING_PATTERN = stemsPattern((stem) => stem === "accommod");
// Choice text and help text: also skips the menu stems ("All meals are vegetarian.", "Vegan").
const CHOICE_TEXT_PATTERN = stemsPattern((stem) => MEAL_MENU_STEMS.has(stem) || stem === "accommod");
const ACCOMMODATION_PATTERN = /\baccommod/i;
// "Accommodation" on its own is a housing word, not a health word, in a housing context ...
const HOUSING_CONTEXT_PATTERN = /\b(?:lodg|hous|rooms?\b|cabin|dorm|campsite|tents?\b|rv\b|overnight)/i;
// ... unless the same wording also asks about needs.
const NEEDS_PATTERN = /\b(?:needs?\b|disab|access|special)/i;

const FILTERABLE_TYPES: ReadonlySet<string> = new Set(["SELECT", "RADIO", "MULTISELECT"]);

export type FlagField = Pick<RegistrationFormField, "type" | "key" | "label" | "helpText" | "options" | "optionLabels" | "optionSource" | "filterable" | "sensitive">;

export type FieldFlagContext = {
  sectionTitle?: string;
  paymentMethodFieldKey?: string | null;
};

function words(text: string) {
  return text.replaceAll("_", " ");
}

/**
 * True when a field's wording reads as health-type (the default for an
 * unflagged field). The single decision used by the builder's saved flag, the
 * answer filter and operational reports.
 */
export function isHealthTypeField(field: FlagField, sectionTitle = "") {
  const wording = [words(field.key), field.label, sectionTitle];
  if (wording.some((text) => WORDING_PATTERN.test(text))) return true;
  // Help text and choice text skip the vegetarian / vegan / gluten stems.
  const secondary = [field.helpText ?? "", ...(field.options ?? []), ...Object.values(field.optionLabels ?? {})].map(words);
  if (secondary.some((text) => CHOICE_TEXT_PATTERN.test(text))) return true;
  // "Accommodation" alone is health-type unless the field reads as housing and asks nothing about needs.
  const accommodation = [...wording, ...secondary].some((text) => ACCOMMODATION_PATTERN.test(text));
  if (!accommodation) return false;
  const context = wording.join(" ");
  return !HOUSING_CONTEXT_PATTERN.test(context) || NEEDS_PATTERN.test(context);
}

/** Whether a field is a choice field that offers a short list of choices. */
export function hasOfferedChoices(field: FlagField) {
  // Directory-sourced lists (churches, clubs) are not a short menu of choices.
  return FILTERABLE_TYPES.has(field.type) && !field.optionSource && (field.options?.length ?? 0) > 0;
}

/**
 * The field's own flags: the explicit value, else the read-time default. The
 * `filterable` default here does not look at other fields; the answer filter
 * adds the linked-field check with the whole form in hand.
 */
export function resolveFieldFlags(field: FlagField, context: FieldFlagContext = {}) {
  const healthType = isHealthTypeField(field, context.sectionTitle ?? "");
  const isPaymentMethod = Boolean(context.paymentMethodFieldKey) && field.key === context.paymentMethodFieldKey;
  return {
    sensitive: field.sensitive ?? healthType,
    filterable: field.filterable ?? (hasOfferedChoices(field) && !healthType && !isPaymentMethod),
  };
}

/**
 * Whether a field is offered as a filter, and whether it is sensitive, with
 * the whole form in hand. The one place both are decided: the answer filter
 * and the builder's "Show as a filter" box use it.
 *
 * With no `filterable` flag, the field is offered only if it would have been
 * before the flags existed (#739): not linked, in either direction, to a
 * sensitive field or to the payment-method field. An explicit flag wins.
 */
export function resolveFieldOffer(
  field: RegistrationFormField,
  context: {
    allFields: readonly RegistrationFormField[];
    sectionTitleOf: (field: RegistrationFormField) => string;
    paymentMethodFieldKey: string | null | undefined;
  },
) {
  const flagsOf = (candidate: RegistrationFormField) => resolveFieldFlags(candidate, {
    sectionTitle: context.sectionTitleOf(candidate),
    paymentMethodFieldKey: context.paymentMethodFieldKey,
  });
  const isPayment = (candidate: RegistrationFormField) => Boolean(context.paymentMethodFieldKey) && candidate.key === context.paymentMethodFieldKey;
  const flags = flagsOf(field);
  const linkedToSensitive = isLinkedToBlockedField(field, context.allFields, (other) => flagsOf(other).sensitive);
  // The payment-method answer is never a filter, whatever its flags say.
  let filterable = hasOfferedChoices(field) && !isPayment(field);
  if (filterable) {
    filterable = field.filterable !== undefined
      ? field.filterable
      : flags.filterable && !linkedToSensitive && !isLinkedToBlockedField(field, context.allFields, isPayment);
  }
  return { filterable, sensitive: flags.sensitive || linkedToSensitive, linkedToSensitive };
}

export function isFieldSensitive(field: FlagField, context: FieldFlagContext = {}) {
  return resolveFieldFlags(field, context).sensitive;
}

/** A lookup from a field to the title of its section, for callers that hold a parsed definition. */
export function sectionTitleLookup(sections: ReadonlyArray<{ title: string; fields: readonly RegistrationFormField[] }>) {
  const titles = new Map<RegistrationFormField, string>();
  for (const section of sections) for (const field of section.fields) titles.set(field, section.title);
  return (field: RegistrationFormField) => titles.get(field) ?? "";
}

/**
 * The definition with an explicit `sensitive: true` written on every
 * health-type field that has no flag yet, so a later rename of the label
 * cannot silently clear it. Fields that already carry a flag are untouched.
 */
export function withExplicitSensitiveFlags<T extends { sections: ReadonlyArray<{ title: string; fields: readonly RegistrationFormField[] }> }>(definition: T): T {
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (
        field.sensitive === undefined && isHealthTypeField(field, section.title) ? { ...field, sensitive: true } : field
      )),
    })),
  };
}
