import type { RegistrationFormField } from "@/modules/forms/definition";
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
 *   whole form, so `resolveFieldFlags` here gives the field's own default and
 *   `offeredQuestion` in `modules/registrations/choice-answer-filter.ts`
 *   adds the link check. Every other field (gender, minor, housing,
 *   childcare, awards and so on) is NOT filterable until staff tick the box.
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

const WORDING_PATTERN = new RegExp(`\\b(?:${SENSITIVE_FIELD_STEMS.join("|")})`, "i");
const CHOICE_TEXT_PATTERN = new RegExp(`\\b(?:${SENSITIVE_FIELD_STEMS.filter((stem) => !MEAL_MENU_STEMS.has(stem)).join("|")})`, "i");

const FILTERABLE_TYPES: ReadonlySet<string> = new Set(["SELECT", "RADIO", "MULTISELECT"]);

export type FlagField = Pick<RegistrationFormField, "type" | "key" | "label" | "helpText" | "options" | "optionLabels" | "optionSource" | "filterable" | "sensitive">;

export type FieldFlagContext = {
  sectionTitle?: string;
  paymentMethodFieldKey?: string | null;
};

function words(text: string) {
  return text.replaceAll("_", " ");
}

/** True when a field's wording reads as health-type (the default for an unflagged field). */
export function isHealthTypeField(field: FlagField, sectionTitle = "") {
  if ([words(field.key), field.label, field.helpText ?? "", sectionTitle].some((text) => WORDING_PATTERN.test(text))) return true;
  return [...(field.options ?? []), ...Object.values(field.optionLabels ?? {})].some((text) => CHOICE_TEXT_PATTERN.test(words(text)));
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
