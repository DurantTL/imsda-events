import type { RegistrationFormField } from "@/modules/forms/definition";

/**
 * Choose controls by the size of the answer set (#484): radio cards read and
 * scan comfortably up to about this many options. Beyond that, a searchable
 * select (already how every SELECT field renders, see
 * `components/searchable-select.tsx`) is faster to use than scrolling a long
 * stack of cards. Multi-select fields always render as checkboxes
 * (`components/public-registration-form.tsx`), regardless of length, so this
 * threshold only decides between the two single-choice presentations —
 * RADIO ("radio cards") and SELECT ("searchable select").
 */
export const RADIO_CARD_MAX_OPTIONS = 8;

/** True for the two single-choice field types this default applies to. */
export function isSingleChoiceType(type: RegistrationFormField["type"]): type is "RADIO" | "SELECT" {
  return type === "RADIO" || type === "SELECT";
}

/**
 * The suggested single-choice control for a given option count: radio cards
 * for a short list, a searchable select for a long directory. This is only
 * ever a default the builder can override — nothing in the schema or
 * renderer requires a RADIO or SELECT field to match it, and switching the
 * "Field type" dropdown directly always wins.
 */
export function suggestedSingleChoiceType(optionCount: number): "RADIO" | "SELECT" {
  return optionCount > RADIO_CARD_MAX_OPTIONS ? "SELECT" : "RADIO";
}
