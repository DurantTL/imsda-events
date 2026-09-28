import { DIRECTORY_NOT_LISTED_VALUE, isDirectoryOptionSource, type RegistrationFormDefinition } from "@/modules/forms/definition";
import type { OrganizationDirectory } from "@/modules/organizations/directory-options";

/** Mirrors `modules/attendee-types/form-options.ts`: stored form JSON records
 * only the source designation, so hydration at read/validation time is
 * authoritative and a club or church rename or deactivation reaches every
 * form immediately. */
function namesFor(source: "CLUBS_DIRECTORY" | "CHURCHES_DIRECTORY", directory: OrganizationDirectory) {
  return source === "CLUBS_DIRECTORY" ? directory.clubs : directory.churches;
}

/** Replaces a directory-sourced field's choices with the live directory plus
 * the "Not listed" sentinel (#482), so the same choice validation every other
 * SELECT/RADIO field uses (`validateTestResponses`) accepts a real directory
 * entry or "Not listed" and rejects anything else. */
export function withDirectoryOptions(
  definition: RegistrationFormDefinition,
  directory: OrganizationDirectory,
): RegistrationFormDefinition {
  if (!hasDirectoryOptionSource(definition)) return definition;
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (
        isDirectoryOptionSource(field.optionSource)
          ? {
            ...field,
            options: [...namesFor(field.optionSource, directory), DIRECTORY_NOT_LISTED_VALUE],
            optionLabels: undefined,
            optionDescriptions: undefined,
          }
          : field
      )),
    })),
  };
}

/** Whether hydrating this definition needs a directory lookup at all, so
 * callers can skip the extra query for the common form with no directory
 * field. */
export function hasDirectoryOptionSource(definition: RegistrationFormDefinition): boolean {
  return definition.sections.some((section) => section.fields.some((field) => isDirectoryOptionSource(field.optionSource)));
}

/** Persisted form JSON must record only the source designation, never a
 * snapshot of currently hydrated choices (mirrors `stripAttendeeTypeOptions`).
 * Call this immediately before writing a definition to storage. */
export function stripDirectoryOptions(definition: RegistrationFormDefinition): RegistrationFormDefinition {
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (
        isDirectoryOptionSource(field.optionSource)
          ? { ...field, options: [], optionLabels: undefined, optionDescriptions: undefined }
          : field
      )),
    })),
  };
}
