import type { RegistrationFormDefinition } from "@/modules/forms/definition";
import type { AttendeeTypeOption } from "@/modules/attendee-types/domain";

/** Replaces sourced field choices at read/validation time. Stored form JSON
 * records only the source designation, so active configuration is authoritative. */
export function withAttendeeTypeOptions(
  definition: RegistrationFormDefinition,
  attendeeTypes: readonly AttendeeTypeOption[] = [],
): RegistrationFormDefinition {
  const active = attendeeTypes
    .filter((type) => type.isActive)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label));
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => field.optionSource === "ATTENDEE_TYPES" ? {
        ...field,
        options: active.map((type) => type.code),
        optionLabels: Object.fromEntries(active.map((type) => [type.code, type.label])),
        optionDescriptions: Object.fromEntries(active.flatMap((type) => type.description ? [[type.code, type.description]] : [])),
      } : field),
    })),
  };
}

/** Hydrates the active choices and, for an existing attendee only, its own
 * historical choice when that type has since been deactivated. */
export function withAttendeeTypeOptionsForAttendee(
  definition: RegistrationFormDefinition,
  attendeeTypes: readonly AttendeeTypeOption[] = [],
  historicalCode?: string | null,
): RegistrationFormDefinition {
  const hydrated = withAttendeeTypeOptions(definition, attendeeTypes);
  if (!historicalCode) return hydrated;
  const historical = attendeeTypes.find((type) => type.code === historicalCode);
  if (!historical || historical.isActive) return hydrated;
  return {
    ...hydrated,
    sections: hydrated.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => field.optionSource === "ATTENDEE_TYPES" && !field.options.includes(historical.code)
        ? {
          ...field,
          options: [...field.options, historical.code],
          optionLabels: { ...(field.optionLabels ?? {}), [historical.code]: historical.label },
          optionDescriptions: historical.description
            ? { ...(field.optionDescriptions ?? {}), [historical.code]: historical.description }
            : field.optionDescriptions,
        }
        : field),
    })),
  };
}

export function attendeeTypeSelector(definition: RegistrationFormDefinition) {
  return definition.sections.flatMap((section) => section.fields).find((field) => field.optionSource === "ATTENDEE_TYPES") ?? null;
}

/** Persisted form JSON must record only the source designation, never a
 * snapshot of currently hydrated choices — otherwise a rename or
 * deactivation in event configuration would not reach a saved draft that
 * was last edited while stale hydrated copies were attached. Call this
 * immediately before writing a definition to storage. */
export function stripAttendeeTypeOptions(definition: RegistrationFormDefinition): RegistrationFormDefinition {
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => field.optionSource === "ATTENDEE_TYPES" ? {
        ...field,
        options: [],
        optionLabels: undefined,
        optionDescriptions: undefined,
        choiceLimits: undefined,
        choicePricesCents: undefined,
        latePricing: undefined,
        availabilityMode: "NONE",
      } : field),
    })),
  };
}
