import {
  getAvailabilityMode,
  isFieldVisible,
  validateTestResponses,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";

const editableFieldTypes = new Set<RegistrationFormField["type"]>([
  "SELECT",
  "RADIO",
  "MULTISELECT",
  "RANKED_CHOICE",
  "CHECKBOX",
  "NUMBER",
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
]);

const sensitiveFieldPattern =
  /\b(?:medical|medication|health|allerg\w*|dietary|accessib\w*|disabil\w*|special\s*needs?|emergency|guardian|minor|age|birth|gender|sex)\b/i;

export type EditableAttendeeField = {
  id: string;
  key: string;
  label: string;
  helpText: string;
  type: "SELECT" | "RADIO" | "MULTISELECT" | "RANKED_CHOICE" | "CHECKBOX" | "NUMBER";
  required: boolean;
  options: string[];
  minSelections: number | null;
  maxSelections: number | null;
  conditional: {
    fieldKey: string;
    operator: "EQUALS" | "NOT_EQUALS" | "INCLUDES" | "NOT_EMPTY";
    value: string;
  } | null;
};

export class AttendeeAnswerUpdateError extends Error {
  constructor(
    public readonly code:
      | "EDIT_POLICY_REQUIRES_VERIFICATION"
      | "NO_EDITABLE_ANSWERS"
      | "FIELD_NOT_EDITABLE"
      | "INVALID_ANSWER",
    message: string,
  ) {
    super(message);
    this.name = "AttendeeAnswerUpdateError";
  }
}

function fieldSemantics(field: RegistrationFormField) {
  return `${field.key.replaceAll("_", " ")} ${field.label}`;
}

export function isTieredAttendeeFieldEditable(field: RegistrationFormField) {
  if (
    field.scope !== "ATTENDEE"
    || !editableFieldTypes.has(field.type)
    || protectedAttendeeKeys.has(field.key)
    || sensitiveFieldPattern.test(fieldSemantics(field))
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

function tieredEditableFieldDefinitions(
  definition: RegistrationFormDefinition,
) {
  const candidates = definition.sections
    .flatMap((section) => section.fields)
    .filter(isTieredAttendeeFieldEditable);
  const candidateKeys = new Set(candidates.map((field) => field.key));
  return candidates.filter((field) => (
    !field.conditional || candidateKeys.has(field.conditional.fieldKey)
  ));
}

export function editableAttendeeFields(
  definition: RegistrationFormDefinition,
  policy: "TIERED" | "VERIFY_EVERY_EDIT",
): EditableAttendeeField[] {
  if (policy !== "TIERED") return [];
  return tieredEditableFieldDefinitions(definition)
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
  if (input.policy !== "TIERED") {
    throw new AttendeeAnswerUpdateError(
      "EDIT_POLICY_REQUIRES_VERIFICATION",
      "This event requires a fresh verification code before attendee answers can be changed.",
    );
  }
  const fields = input.definition.sections.flatMap((section) => section.fields);
  const editable = tieredEditableFieldDefinitions(input.definition);
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

  const responses = {
    ...input.currentResponses,
    ...Object.fromEntries(
      Object.entries(input.changes).map(([key, value]) => [key, normalizedValue(value)]),
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
    { ignoreAvailability: true, ignoredFieldKeys },
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
