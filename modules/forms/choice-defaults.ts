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
 *
 * This is deliberately applied only when a field is *created* — a fresh
 * choice field (`resolvedTypeForFieldTypeChange`) or a field arriving with a
 * module (`instantiateModuleFields` in `modules/forms/builder-modules.ts`) —
 * never on a later edit to an existing field's options. Re-suggesting on
 * every options edit was tried and reverted: it silently overwrote a
 * builder's deliberate choice (an explicit RADIO kept at 12 options after a
 * typo fix would flip to SELECT; a template's 3-option SELECT would flip to
 * RADIO on any edit).
 */
export function suggestedSingleChoiceType(optionCount: number): "RADIO" | "SELECT" {
  return optionCount > RADIO_CARD_MAX_OPTIONS ? "SELECT" : "RADIO";
}

/**
 * The type to apply when the builder changes a field's "Field type" to
 * `nextType`. A field that is *becoming* a single-choice field for the first
 * time (its prior type wasn't already RADIO or SELECT — e.g. a plain text
 * field, or a multi-select with many options, switching to "Single choice"
 * or "Dropdown") gets the size-appropriate default instead of the literal
 * dropdown value, computed from the option count it will carry after the
 * switch. Once a field is already RADIO or SELECT, further edits (including
 * to its options) always keep the builder's own choice — see
 * `suggestedSingleChoiceType`.
 */
export function resolvedTypeForFieldTypeChange(
  priorType: RegistrationFormField["type"],
  nextType: RegistrationFormField["type"],
  nextOptionCount: number,
): RegistrationFormField["type"] {
  if (!isSingleChoiceType(nextType) || isSingleChoiceType(priorType)) return nextType;
  return suggestedSingleChoiceType(nextOptionCount);
}
