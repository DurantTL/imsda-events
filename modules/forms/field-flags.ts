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
 * before the flags existed, and any field staff has not touched):
 *
 * - `sensitive` defaults to true for health-type fields, decided by the
 *   codebase's shared health/medical/allergy/insurance word list
 *   (`SENSITIVE_FIELD_STEMS`) read from the field's key, label, help text,
 *   section title and choice text.
 * - `filterable` defaults to true for an ordinary choice field (drop-down,
 *   radio group or multi-select) that is not health-type and is not the
 *   payment-method field. That is exactly what the #739 word list used to
 *   allow, so the Women's Retreat meal filter keeps working after deploy.
 *
 * An explicit true or false always wins over the default. This is a read-time
 * default, not a data migration: nothing stored is rewritten.
 */

/**
 * Choice text such as "Vegetarian", "Vegan" or "Gluten-free" on an ordinary
 * meal menu does not make the question health-type. This applies only to the
 * legacy default for fields that carry no flags; staff can set either flag
 * explicitly.
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

/** The field's flags: the explicit value, else the read-time default. */
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
