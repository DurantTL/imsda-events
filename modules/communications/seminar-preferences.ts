import type { Prisma } from "@prisma/client";
import { isSeminarPreferenceField } from "@/modules/attendee-accounts/registration-answer-policy";
import {
  buildSeminarPreferencesBlock,
  type SeminarAttendee,
} from "@/modules/communications/message-blocks";
import {
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { publicAttendeeName } from "@/modules/public-access/domain";

type SeminarReadClient = Pick<Prisma.TransactionClient, "registration" | "programAttendeeAssignment">;
type SeminarBatchClient = SeminarReadClient & Pick<Prisma.TransactionClient, "registrationFormVersion">;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function seminarFieldsOf(definition: unknown): RegistrationFormField[] {
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  return parsed.success
    ? parsed.data.sections.flatMap((section) => section.fields).filter(isSeminarPreferenceField)
    : [];
}

type AttendeeRow = {
  id: string;
  formResponses: unknown;
  profileSnapshot: unknown;
  person: { firstName: string; lastName: string };
};
type AssignmentRow = {
  attendeeIdSnapshot: string;
  optionValue: string | null;
  run: { fieldKeySnapshot: string };
};

function assembleSeminarAttendees(
  attendees: readonly AttendeeRow[],
  seminarFields: readonly RegistrationFormField[],
  assignments: readonly AssignmentRow[],
): SeminarAttendee[] {
  return attendees.map((attendee) => {
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
  const seminarFields = version ? seminarFieldsOf(version.definition) : [];
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
  return assembleSeminarAttendees(registration.attendees, seminarFields, assignments);
}

/** The `{{seminar_preferences}}` value for one registration, from its own data. */
export async function buildRegistrationSeminarPreferences(
  client: SeminarReadClient,
  input: { eventId: string; registrationId: string },
) {
  return buildSeminarPreferencesBlock(await loadSeminarAttendees(client, input));
}

/**
 * The same blocks for many registrations in four queries, whatever their
 * number: registrations and attendees, each distinct form version once,
 * and every current assignment. A broadcast uses this so its single send
 * transaction does not query once per recipient.
 */
export async function buildSeminarPreferencesBlocks(
  client: SeminarBatchClient,
  input: { eventId: string; registrationIds: readonly string[] },
): Promise<Map<string, string>> {
  const blocks = new Map<string, string>();
  if (input.registrationIds.length === 0) return blocks;
  const registrations = await client.registration.findMany({
    where: { id: { in: [...input.registrationIds] }, eventId: input.eventId },
    select: {
      id: true,
      publicFormSubmission: { select: { formVersionId: true } },
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
  const versionIds = [...new Set(registrations.flatMap((registration) => (
    registration.publicFormSubmission ? [registration.publicFormSubmission.formVersionId] : []
  )))];
  const versions = versionIds.length > 0
    ? await client.registrationFormVersion.findMany({
        where: { id: { in: versionIds } },
        select: { id: true, formId: true, definition: true },
      })
    : [];
  // Each definition is parsed once, however many registrations use it.
  const fieldsByVersion = new Map(versions.map((version) => [
    version.id,
    { formId: version.formId, fields: seminarFieldsOf(version.definition) },
  ]));
  const seminarKeys = [...new Set([...fieldsByVersion.values()].flatMap((entry) => (
    entry.fields.map((field) => field.key)
  )))];
  const attendeeIds = registrations.flatMap((registration) => (
    registration.attendees.map((attendee) => attendee.id)
  ));
  const assignments = seminarKeys.length > 0 && attendeeIds.length > 0
    ? await client.programAttendeeAssignment.findMany({
        where: {
          attendeeIdSnapshot: { in: attendeeIds },
          outcome: "ASSIGNED",
          optionValue: { not: null },
          run: {
            eventId: input.eventId,
            fieldKeySnapshot: { in: seminarKeys },
            invalidatedAt: null,
            supersededBy: { none: {} },
          },
        },
        select: {
          attendeeIdSnapshot: true,
          optionValue: true,
          run: { select: { fieldKeySnapshot: true, formId: true } },
        },
      })
    : [];
  const assignmentsByAttendee = new Map<string, Array<AssignmentRow & { run: { formId: string } }>>();
  for (const assignment of assignments) {
    const list = assignmentsByAttendee.get(assignment.attendeeIdSnapshot) ?? [];
    list.push(assignment);
    assignmentsByAttendee.set(assignment.attendeeIdSnapshot, list);
  }
  for (const registration of registrations) {
    const entry = registration.publicFormSubmission
      ? fieldsByVersion.get(registration.publicFormSubmission.formVersionId)
      : undefined;
    if (!entry) {
      blocks.set(registration.id, "");
      continue;
    }
    const relevant = registration.attendees.flatMap((attendee) => (
      (assignmentsByAttendee.get(attendee.id) ?? []).filter((assignment) => assignment.run.formId === entry.formId)
    ));
    blocks.set(
      registration.id,
      buildSeminarPreferencesBlock(assembleSeminarAttendees(registration.attendees, entry.fields, relevant)),
    );
  }
  return blocks;
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
