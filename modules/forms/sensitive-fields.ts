import type { RegistrationFormField } from "@/modules/forms/definition";

/**
 * One shared list of word stems for form fields that read as medical, health,
 * insurance, custody or other personal answers. Reports and drafts that must
 * never show or keep such answers build on this list instead of keeping their
 * own copy (the public-draft exclusion adds its payment and notes stems).
 *
 * Stems are matched from a word start, without a trailing word boundary, so
 * "medic" catches "medications" and "insur" catches "Insurer". A few stems
 * carry their own trailing boundary to avoid common false hits.
 */
export const SENSITIVE_FIELD_STEMS: readonly string[] = [
  "medic", "meds?\\b", "prescri", "insur", "health", "condition", "accommod", "restrict",
  "allerg", "dietar", "diet\\b", "physician", "doctor", "epi\\W?pen", "inhaler", "asthma", "seizure",
  "immuni[sz]", "vaccin", "tetanus", "mental", "diabet", "epilep", "pregnan", "therap", "counsel",
  "behavio", "limitation", "sensitiv", "vegetarian", "vegan", "gluten", "wheelchair", "mobility",
  "pediatric", "hospital", "clinic", "blood", "diagnos", "disab", "accessib", "special\\s*needs?",
  "policy\\s*(?:number|holder)", "birth", "bday", "d\\W?o\\W?b\\b", "guardian", "parent", "pick\\s?up",
  "custody", "emergency", "background", "ssn", "social\\s*security",
  "injur", "surg", "ill(?:ness)?\\b", "sick", "symptom", "treatment", "anxi", "depress", "adhd", "autis",
  "hearing", "vision", "impair", "lactose", "nut\\s*free", "care\\s*plan",
  "celiac", "intoleran",
];

export function sensitiveFieldPattern(extraStems: readonly string[] = []) {
  return new RegExp(`\\b(?:${[...SENSITIVE_FIELD_STEMS, ...extraStems].join("|")})`, "i");
}

const SENSITIVE_FIELD_PATTERN = sensitiveFieldPattern();

/** True when the text (already split into words) reads as a sensitive answer. */
export function isSensitiveFieldText(text: string) {
  return SENSITIVE_FIELD_PATTERN.test(text);
}

/**
 * Whether a field's own key, label, help text or choice labels read as
 * sensitive. Snake_case keys are split into words so `current_medications`
 * matches as well as its label.
 */
export function isSensitiveField(
  field: Pick<RegistrationFormField, "key" | "label" | "helpText" | "options" | "optionLabels">,
  pattern: RegExp = SENSITIVE_FIELD_PATTERN,
) {
  const parts = [
    field.key.replaceAll("_", " "),
    field.label,
    field.helpText ?? "",
    ...(field.options ?? []),
    ...Object.values(field.optionLabels ?? {}),
  ];
  return parts.some((part) => pattern.test(part.replaceAll("_", " ")));
}
