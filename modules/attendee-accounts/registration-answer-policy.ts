import { normalizePhoneAnswer } from "@/lib/field-validation";
import { sanitizeAddressInput } from "@/modules/forms/address";
import {
  getAvailabilityMode,
  isFieldVisible,
  validateTestResponses,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { visibilityControllerKeys } from "@/modules/forms/visibility-rule";

const editableFieldTypes = new Set<RegistrationFormField["type"]>([
  "SELECT",
  "RADIO",
  "MULTISELECT",
  "RANKED_CHOICE",
  "CHECKBOX",
  "NUMBER",
  "ADDRESS",
]);

const protectedAttendeeKeys = new Set([
  "first_name",
  "last_name",
  "full_name",
  "name",
  "attendee_name",
  "guest_name",
  "attendee_type",
  "registration_fee",
  // Who is the team's alternate (#809) is the director's call, with the team rules checked: never an attendee's own edit.
  "alternate",
]);

const sensitiveFieldPattern =
  /\b(?:medical|medication|health|allerg\w*|dietary|accessib\w*|disabil\w*|special\s*needs?|emergency|guardian|minor|age|birth|gender|sex)\b/i;

export type EditableAttendeeField = {
  id: string;
  key: string;
  label: string;
  helpText: string;
  /** PHONE, EMAIL and DATE are not self-service editable today (see `editableFieldTypes`); the form checks them if they ever are. */
  type: "SELECT" | "RADIO" | "MULTISELECT" | "RANKED_CHOICE" | "CHECKBOX" | "NUMBER" | "ADDRESS" | "PHONE" | "EMAIL" | "DATE";
  required: boolean;
  options: string[];
  minSelections: number | null;
  maxSelections: number | null;
  conditional: {
    fieldKey: string;
    operator: "EQUALS" | "NOT_EQUALS" | "INCLUDES" | "NOT_EMPTY";
    value: string;
  } | null;
  /** Several conditions joined by All or Any (#1072); null when the question has a single condition or none. */
  conditionalGroup: {
    match: "ALL" | "ANY";
    conditions: Array<{ fieldKey: string; operator: "EQUALS" | "NOT_EQUALS" | "INCLUDES" | "NOT_EMPTY"; value: string }>;
  } | null;
};

export class AttendeeAnswerUpdateError extends Error {
  constructor(
    public readonly code:
      | "EDIT_POLICY_REQUIRES_VERIFICATION"
      | "NO_EDITABLE_ANSWERS"
      | "FIELD_NOT_EDITABLE"
      | "INVALID_ANSWER"
      | "SEMINAR_PREFERENCES_LOCKED"
      | "FINAL_ASSIGNMENT_LOCKED"
      | "IDEMPOTENCY_KEY_REUSED",
    message: string,
  ) {
    super(message);
    this.name = "AttendeeAnswerUpdateError";
  }
}

function fieldSemantics(field: RegistrationFormField) {
  return `${field.key.replaceAll("_", " ")} ${field.label}`;
}

/** ADR 0005 protected categories (medical, guardian, minor, age, birth, gender, sex ...) by key or label. */
export function isProtectedAnswerField(field: Pick<RegistrationFormField, "key" | "label">) {
  return sensitiveFieldPattern.test(fieldSemantics(field as RegistrationFormField));
}

export function isTieredAttendeeFieldEditable(field: RegistrationFormField) {
  if (
    field.scope !== "ATTENDEE"
    || !editableFieldTypes.has(field.type)
    || protectedAttendeeKeys.has(field.key)
    || isProtectedAnswerField(field)
  ) {
    return false;
  }
  if (
    field.priceCents !== undefined
    || field.choicePricesCents !== undefined
    || field.latePricing !== undefined
    || getAvailabilityMode(field) === "CAPACITY"
  ) {
    return false;
  }
  return true;
}

export function isSeminarPreferenceField(field: RegistrationFormField) {
  return field.scope === "ATTENDEE"
    && field.type === "RANKED_CHOICE"
    && getAvailabilityMode(field) === "RANKED_INTEREST";
}

function tieredEditableFieldDefinitions(
  definition: RegistrationFormDefinition,
  policy: "TIERED" | "VERIFY_EVERY_EDIT",
) {
  const candidates = definition.sections
    .flatMap((section) => section.fields)
    .filter((field) => (
      isSeminarPreferenceField(field)
      || (policy === "TIERED" && isTieredAttendeeFieldEditable(field))
    ));
  const candidateKeys = new Set(candidates.map((field) => field.key));
  // Every member of a rule must be a controller the browser may see, or the question stays staff-managed.
  return candidates.filter((field) => (
    visibilityControllerKeys(field).every((key) => candidateKeys.has(key))
  ));
}

export function editableAttendeeFields(
  definition: RegistrationFormDefinition,
  policy: "TIERED" | "VERIFY_EVERY_EDIT",
): EditableAttendeeField[] {
  return tieredEditableFieldDefinitions(definition, policy)
    // A condition controlled by a protected or registration-level answer
    // cannot be evaluated in the browser without disclosing that answer.
    // Keep the field staff-managed instead of exposing hidden context.
    .map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      helpText: field.helpText,
      type: field.type as EditableAttendeeField["type"],
      required: field.required,
      options: field.options,
      minSelections: field.minSelections ?? null,
      maxSelections: field.maxSelections ?? null,
      conditional: field.conditional ?? null,
      conditionalGroup: field.conditionalGroup ?? null,
    }));
}

function normalizedValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item.trim() : item);
  }
  return value;
}

export function prepareTieredAttendeeAnswerUpdate(input: {
  definition: RegistrationFormDefinition;
  policy: "TIERED" | "VERIFY_EVERY_EDIT";
  registrationResponses: Record<string, unknown>;
  currentResponses: Record<string, unknown>;
  changes: Record<string, unknown>;
}) {
  const fields = input.definition.sections.flatMap((section) => section.fields);
  const editable = tieredEditableFieldDefinitions(input.definition, input.policy);
  if (editable.length === 0) {
    throw new AttendeeAnswerUpdateError(
      "NO_EDITABLE_ANSWERS",
      "This registration has no attendee answers available for self-service editing.",
    );
  }
  const editableKeys = new Set(editable.map((field) => field.key));
  for (const key of Object.keys(input.changes)) {
    if (!editableKeys.has(key)) {
      throw new AttendeeAnswerUpdateError(
        "FIELD_NOT_EDITABLE",
        `${key} cannot be changed through attendee self-service.`,
      );
    }
  }

  const editableByKey = new Map(editable.map((field) => [field.key, field]));
  const responses = {
    ...input.currentResponses,
    ...Object.fromEntries(
      Object.entries(input.changes).map(([key, value]) => [
        key,
        editableByKey.get(key)?.type === "ADDRESS" ? sanitizeAddressInput(value) : editableByKey.get(key)?.type === "PHONE" ? normalizePhoneAnswer(normalizedValue(value)) : normalizedValue(value),
      ]),
    ),
  };
  const merged = { ...input.registrationResponses, ...responses };
  for (const field of editable) {
    if (Object.hasOwn(responses, field.key) && !isFieldVisible(field, merged)) {
      delete responses[field.key];
    }
  }

  const ignoredFieldKeys = fields
    .filter((field) => field.scope === "ATTENDEE" && !editableKeys.has(field.key))
    .map((field) => field.key);
  const validation = validateTestResponses(
    input.definition,
    { ...input.registrationResponses, ...responses },
    {},
    "ATTENDEE",
    { ignoreAvailability: true, ignoredFieldKeys, previousResponses: { ...input.registrationResponses, ...input.currentResponses } },
  );
  if (!validation.isValid) {
    throw new AttendeeAnswerUpdateError(
      "INVALID_ANSWER",
      validation.issues[0]?.message ?? "Review the attendee choices and try again.",
    );
  }
  return {
    responses,
    changedKeys: Object.keys(input.changes).sort(),
  };
}
