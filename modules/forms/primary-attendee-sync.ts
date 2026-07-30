import type { RegistrationFormDefinition } from "@/modules/forms/definition";

const firstNameSourceKeys = [
  "primary_contact_first_name",
  "contact_first_name",
  "registrant_first_name",
] as const;

const lastNameSourceKeys = [
  "primary_contact_last_name",
  "contact_last_name",
  "registrant_last_name",
] as const;

export type PrimaryAttendeeNameSync = {
  registrationFirstNameKey: string;
  registrationLastNameKey: string;
  attendeeFirstNameKey: string;
  attendeeLastNameKey: string;
};

export function getPrimaryAttendeeNameSync(
  definition: RegistrationFormDefinition,
): PrimaryAttendeeNameSync | null {
  if (!definition.attendeeRoster?.enabled) return null;
  const fields = definition.sections.flatMap((section) => section.fields);
  const registrationFirstName = fields.find((field) => (
    field.scope === "REGISTRATION"
    && firstNameSourceKeys.includes(
      field.key as typeof firstNameSourceKeys[number],
    )
  ));
  const registrationLastName = fields.find((field) => (
    field.scope === "REGISTRATION"
    && lastNameSourceKeys.includes(
      field.key as typeof lastNameSourceKeys[number],
    )
  ));
  const attendeeFirstName = fields.find((field) => (
    field.scope === "ATTENDEE" && field.key === "first_name"
  ));
  const attendeeLastName = fields.find((field) => (
    field.scope === "ATTENDEE" && field.key === "last_name"
  ));
  if (
    !registrationFirstName
    || !registrationLastName
    || !attendeeFirstName
    || !attendeeLastName
  ) return null;
  return {
    registrationFirstNameKey: registrationFirstName.key,
    registrationLastNameKey: registrationLastName.key,
    attendeeFirstNameKey: attendeeFirstName.key,
    attendeeLastNameKey: attendeeLastName.key,
  };
}

function comparable(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

/**
 * Keeps the first attendee's name with the primary contact while the attendee
 * value is blank or still matches the prior primary-contact value. Once a
 * registrant deliberately types another attendee name, later contact edits do
 * not overwrite it.
 */
export function syncFirstAttendeeNameChange(
  sync: PrimaryAttendeeNameSync | null,
  changedRegistrationKey: string,
  previousRegistrationValue: unknown,
  nextRegistrationValue: unknown,
  attendeeResponses: Record<string, unknown>,
) {
  if (!sync || typeof nextRegistrationValue !== "string") {
    return attendeeResponses;
  }
  const attendeeKey = changedRegistrationKey === sync.registrationFirstNameKey
    ? sync.attendeeFirstNameKey
    : changedRegistrationKey === sync.registrationLastNameKey
      ? sync.attendeeLastNameKey
      : null;
  if (!attendeeKey) return attendeeResponses;

  const attendeeValue = attendeeResponses[attendeeKey];
  if (
    comparable(attendeeValue)
    && comparable(attendeeValue) !== comparable(previousRegistrationValue)
  ) {
    return attendeeResponses;
  }
  return {
    ...attendeeResponses,
    [attendeeKey]: nextRegistrationValue,
  };
}
