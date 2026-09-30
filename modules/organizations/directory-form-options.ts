import { DIRECTORY_NOT_LISTED_VALUE, isDirectoryOptionSource, type DirectoryOptionSource, type RegistrationFormDefinition } from "@/modules/forms/definition";
import type { OrganizationDirectory } from "@/modules/organizations/directory-options";

/** Mirrors `modules/attendee-types/form-options.ts`: stored form JSON records
 * only the source designation, so hydration at read/validation time is
 * authoritative and a club or church rename or deactivation reaches every
 * form immediately. */
function namesFor(source: DirectoryOptionSource, directory: OrganizationDirectory) {
  if (source === "CLUBS_DIRECTORY") return directory.clubs;
  return source === "SCHOOLS_DIRECTORY" ? directory.schools : directory.churches;
}

/** Replaces a directory-sourced field's choices with the live directory plus
 * the "Not listed" sentinel (#482), so the same choice validation every other
 * SELECT/RADIO field uses (`validateTestResponses`) accepts a real directory
 * entry or "Not listed" and rejects anything else.
 *
 * `retainedResponses` are an existing registration's stored answers: a value
 * one of them holds for a directory field that is no longer in the live
 * directory (the organization was renamed or deactivated since) is kept as a
 * choice, so the historical answer still shows and still validates when the
 * registration is amended — the same rule `withAttendeeTypeOptionsForAttendee`
 * applies to a deactivated attendee type. Never pass these for a new
 * registration. */
export function withDirectoryOptions(
  definition: RegistrationFormDefinition,
  directory: OrganizationDirectory,
  retainedResponses: Record<string, unknown> = {},
): RegistrationFormDefinition {
  if (!hasDirectoryOptionSource(definition)) return definition;
  const optionsFor = (source: DirectoryOptionSource, key: string) => {
    const options = namesFor(source, directory).filter((name) => name !== DIRECTORY_NOT_LISTED_VALUE);
    const retained = retainedResponses[key];
    if (typeof retained === "string" && retained.trim() && retained !== DIRECTORY_NOT_LISTED_VALUE && !options.includes(retained)) {
      options.push(retained);
    }
    options.push(DIRECTORY_NOT_LISTED_VALUE);
    return options;
  };
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (
        isDirectoryOptionSource(field.optionSource)
          ? {
            ...field,
            options: optionsFor(field.optionSource, field.key),
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
