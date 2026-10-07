import type { Prisma } from "@prisma/client";
import { isSeminarPreferenceField } from "@/modules/attendee-accounts/registration-answer-policy";
import {
  buildSeminarPreferencesBlock,
  type SeminarAttendee,
} from "@/modules/communications/message-blocks";
import {
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { publicAttendeeName } from "@/modules/public-access/domain";

type SeminarReadClient = Pick<Prisma.TransactionClient, "registration" | "programAttendeeAssignment">;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The registration's own seminar answers, from its stored attendee responses:
 * each attendee, each of the form's ranked seminar fields in the order they
 * ranked it, and the seminar the seminar assignments module placed them in
 * where a current (not invalidated, not superseded) assignment exists.
 *
 * Reads only this registration. Returns no fields when the form has no seminar
 * choice, which the block builder turns into an omitted section.
 */
export async function loadSeminarAttendees(
  client: SeminarReadClient,
  input: { eventId: string; registrationId: string },
): Promise<SeminarAttendee[]> {
  const registration = await client.registration.findFirst({
    where: { id: input.registrationId, eventId: input.eventId },
    select: {
      publicFormSubmission: {
        select: { formVersion: { select: { definition: true, formId: true } } },
      },
      attendees: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          formResponses: true,
          profileSnapshot: true,
          person: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!registration) return [];

  const version = registration.publicFormSubmission?.formVersion;
  const parsed = version ? registrationFormDefinitionSchema.safeParse(version.definition) : null;
  const seminarFields = parsed?.success
    ? parsed.data.sections.flatMap((section) => section.fields).filter(isSeminarPreferenceField)
    : [];

  const assignments = version && seminarFields.length > 0
    ? await client.programAttendeeAssignment.findMany({
        where: {
          attendeeIdSnapshot: { in: registration.attendees.map((attendee) => attendee.id) },
          outcome: "ASSIGNED",
          optionValue: { not: null },
          run: {
            eventId: input.eventId,
            formId: version.formId,
            fieldKeySnapshot: { in: seminarFields.map((field) => field.key) },
            invalidatedAt: null,
            supersededBy: { none: {} },
          },
        },
        select: {
          attendeeIdSnapshot: true,
          optionValue: true,
          run: { select: { fieldKeySnapshot: true } },
        },
      })
    : [];

  return registration.attendees.map((attendee) => {
    const responses = record(attendee.formResponses);
    return {
      name: publicAttendeeName(attendee.profileSnapshot, attendee.person),
      fields: seminarFields.map((field) => {
        const value = responses[field.key];
        return {
          label: field.label,
          // Ranked order is the stored order; labels no longer on the form are dropped.
          choices: Array.isArray(value)
            ? value
                .filter((choice): choice is string => (
                  typeof choice === "string" && field.options.includes(choice)
                ))
                .map((choice) => field.optionLabels?.[choice] ?? choice)
            : [],
          assigned: assignments
            .filter((assignment) => (
              assignment.attendeeIdSnapshot === attendee.id
              && assignment.run.fieldKeySnapshot === field.key
              && assignment.optionValue
            ))
            .map((assignment) => (
              field.optionLabels?.[assignment.optionValue as string] ?? assignment.optionValue as string
            )),
        };
      }),
    };
  });
}

/** The `{{seminar_preferences}}` value for one registration, from its own data. */
export async function buildRegistrationSeminarPreferences(
  client: SeminarReadClient,
  input: { eventId: string; registrationId: string },
) {
  return buildSeminarPreferencesBlock(await loadSeminarAttendees(client, input));
}

/**
 * The same block for a registration that is being created right now, from the
 * submitted answers themselves. No assignment can exist yet, and the stored
 * submission link may not be written when the confirmation is queued.
 */
export function buildSubmittedSeminarPreferences(input: {
  definition: RegistrationFormDefinition;
  attendeeResponses: ReadonlyArray<Record<string, unknown>>;
  /** Names a single unnamed attendee, who is the registrant themselves. */
  registrantName: string;
}) {
  const seminarFields = input.definition.sections
    .flatMap((section) => section.fields)
    .filter(isSeminarPreferenceField);
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  return buildSeminarPreferencesBlock(input.attendeeResponses.map((responses, index) => ({
    name: `${text(responses.first_name)} ${text(responses.last_name)}`.trim()
      || text(responses.full_name)
      || text(responses.name)
      || (input.attendeeResponses.length === 1 ? input.registrantName : `Attendee ${index + 1}`),
    fields: seminarFields.map((field) => {
      const value = responses[field.key];
      return {
        label: field.label,
        choices: Array.isArray(value)
          ? value
              .filter((choice): choice is string => (
                typeof choice === "string" && field.options.includes(choice)
              ))
              .map((choice) => field.optionLabels?.[choice] ?? choice)
          : [],
        assigned: [],
      };
    }),
  })));
}
