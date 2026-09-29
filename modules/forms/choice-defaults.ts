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
 * ever a suggestion — nothing here rewrites a field's type. The builder's
 * pick in the "Field type" dropdown always stands, and module inserts keep
 * the type each module declares (the module data itself is written to
 * follow this rule; see `tests/roster-field-bundle-module.test.ts`). The
 * builder sees the suggestion as a dismissible hint with a one-click switch
 * (`singleChoiceTypeHint`).
 */
export function suggestedSingleChoiceType(optionCount: number): "RADIO" | "SELECT" {
  return optionCount > RADIO_CARD_MAX_OPTIONS ? "SELECT" : "RADIO";
}

export type SingleChoiceTypeHint = {
  suggestedType: "RADIO" | "SELECT";
  message: string;
  actionLabel: string;
};

/**
 * The size-based suggestion to show on a single-choice field, or null when
 * there is nothing to suggest: the field isn't RADIO/SELECT, its options come
 * from the event's attendee types (not builder-configured), or its type
 * already matches the suggestion. Acting on the hint is the builder's choice;
 * dismissing it or ignoring it leaves the field exactly as it is.
 */
export function singleChoiceTypeHint(
  field: Pick<RegistrationFormField, "type" | "options" | "optionSource">,
): SingleChoiceTypeHint | null {
  if (!isSingleChoiceType(field.type) || field.optionSource) return null;
  const suggestedType = suggestedSingleChoiceType(field.options.length);
  if (suggestedType === field.type) return null;
  return suggestedType === "RADIO"
    ? { suggestedType, message: "Short list: radio cards are easier to tap.", actionLabel: "Switch to radio cards" }
    : { suggestedType, message: "Long list: a searchable dropdown is faster than scrolling this many cards.", actionLabel: "Switch to a searchable dropdown" };
}

/**
 * FB-9 (#569): a choice field the builder is creating (converting a
 * non-choice field into a "Dropdown") with this many choices or fewer starts
 * as radio cards. Only newly created choice fields are affected: existing
 * fields, module inserts, and published forms keep the type they have.
 */
export const NEW_FIELD_RADIO_MAX_OPTIONS = 6;

/**
 * The type a builder's field-type pick lands on. Picking "Dropdown" for a
 * field that was not a choice field yet, with a short list, gives radio cards
 * (the builder can "Keep dropdown"); every other transition is taken as picked.
 */
export function defaultTypeForNewChoiceField(
  previousType: RegistrationFormField["type"],
  requestedType: RegistrationFormField["type"],
  optionCount: number,
): RegistrationFormField["type"] {
  const wasChoice = ["SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE"].includes(previousType);
  if (requestedType === "SELECT" && !wasChoice && optionCount <= NEW_FIELD_RADIO_MAX_OPTIONS) return "RADIO";
  return requestedType;
}
