import "server-only";

import type { AttendeeTypeOption } from "@/modules/attendee-types/domain";
import { withAttendeeTypeOptions } from "@/modules/attendee-types/form-options";
import type { RegistrationFormDefinition } from "@/modules/forms/definition";
import { hasDirectoryOptionSource, withDirectoryOptions } from "@/modules/organizations/directory-form-options";
import {
  getOrganizationDirectory,
  type DirectoryReadClient,
  type OrganizationDirectory,
} from "@/modules/organizations/directory-options";

export type HydrateFormOptionsInput = {
  /**
   * The event's attendee types, for an `ATTENDEE_TYPES` selector. Omit to
   * leave any attendee-type selector exactly as stored (for a caller that
   * never validates or shows it).
   */
  attendeeTypes?: readonly AttendeeTypeOption[];
  /**
   * Where to read the live directory from. Pass the transaction client when
   * hydrating inside one, so validation reads the same snapshot the write
   * does. Defaults to the app client.
   */
  client?: DirectoryReadClient;
  /** An already-loaded directory, e.g. one read once for a whole list. */
  directory?: OrganizationDirectory;
  /**
   * An existing registration's current answers, so a club or church it holds
   * that has left the live directory stays a valid choice (see
   * `withDirectoryOptions`). Omit for a new registration.
   */
  retainedResponses?: Record<string, unknown>;
};

/**
 * The one way to turn a stored form definition into the one that is
 * validated against or sent to an editor (#482): stored JSON records only the
 * option source for attendee-type and directory fields, so every such caller
 * must hydrate them first, or those fields validate and render against an
 * empty list. The directory is read only when the form actually has a
 * directory-sourced field.
 */
export async function hydrateFormOptions(
  definition: RegistrationFormDefinition,
  input: HydrateFormOptionsInput = {},
): Promise<RegistrationFormDefinition> {
  let hydrated = input.attendeeTypes
    ? withAttendeeTypeOptions(definition, input.attendeeTypes)
    : definition;
  if (hasDirectoryOptionSource(hydrated)) {
    const directory = input.directory ?? await getOrganizationDirectory(input.client);
    hydrated = withDirectoryOptions(hydrated, directory, input.retainedResponses);
  }
  return hydrated;
}

/** Reads the directory once for several definitions, only if any needs it. */
export async function directoryForDefinitions(
  definitions: readonly RegistrationFormDefinition[],
  client?: DirectoryReadClient,
): Promise<OrganizationDirectory> {
  return definitions.some(hasDirectoryOptionSource)
    ? getOrganizationDirectory(client)
    : { clubs: [], churches: [], schools: [] };
}
