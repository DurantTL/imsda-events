import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  AttendeeAnswerUpdateError,
  editableAttendeeFields,
  isSeminarPreferenceField,
  prepareTieredAttendeeAnswerUpdate,
} from "@/modules/attendee-accounts/registration-answer-policy";
import { enqueueRegistrationUpdatedMessage } from "@/modules/communications/transactional-messages";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicAttendeeName } from "@/modules/public-access/domain";

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function valuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function updateTieredRegistrationAnswersWithClient(
  tx: Prisma.TransactionClient,
  input: {
    registrationId: string;
    clientRequestId: string;
    expectedUpdatedAt: string;
    attendees: Array<{
      attendeeId: string;
      responses: Record<string, unknown>;
    }>;
    now: Date;
    audit: {
      action: string;
      summary: (confirmationCode: string) => string;
      metadata: Record<string, string | number | boolean | null>;
    };
  },
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "Registration"
    WHERE "id" = ${input.registrationId}
      AND "status" IN ('SUBMITTED', 'CONFIRMED', 'WAITLISTED')
    FOR UPDATE
  `);
  const registration = await tx.registration.findFirst({
    where: {
      id: input.registrationId,
      status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED"] },
    },
    select: {
      id: true,
      eventId: true,
      confirmationCode: true,
      updatedAt: true,
      event: {
        select: {
          attendeeEditPolicy: true,
          timezone: true,
          seminarPreferenceClosesOn: true,
          seminarPreferenceSelfServiceLocked: true,
        },
      },
      publicFormSubmission: {
        select: {
          responses: true,
          formVersionId: true,
          formVersion: { select: { definition: true } },
        },
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
  if (!registration) return null;
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    expectedUpdatedAt: input.expectedUpdatedAt,
    attendees: input.attendees,
  })).digest("hex");
  const priorRequest = await tx.auditLog.findFirst({
    where: {
      eventId: registration.eventId,
      entityId: registration.id,
      action: input.audit.action,
      correlationId: input.clientRequestId,
    },
    select: { metadata: true },
  });
  if (priorRequest) {
    const metadata = recordFromJson(priorRequest.metadata);
    if (metadata.requestFingerprint !== requestFingerprint) {
      throw new AttendeeAnswerUpdateError(
        "IDEMPOTENCY_KEY_REUSED",
        "That update request ID was already used for different choices. Refresh and try again.",
      );
    }
    return {
      ...(metadata.response as {
        expectedUpdatedAt: string;
        attendees: Array<{
          attendeeId: string;
          name: string;
          responses: Record<string, unknown>;
        }>;
      }),
      pendingMessageIds: [] as string[],
    };
  }
  if (!registration.publicFormSubmission) {
    throw new AttendeeAnswerUpdateError(
      "NO_EDITABLE_ANSWERS",
      "This registration is not connected to a published form, so the event team must update its attendee choices.",
    );
  }
  if (registration.updatedAt.toISOString() !== input.expectedUpdatedAt) {
    throw new AttendeeAnswerUpdateError(
      "INVALID_ANSWER",
      "This registration changed after you opened it. Refresh and review the latest answers.",
    );
  }

  const submission = registration.publicFormSubmission;
  const definition = registrationFormDefinitionSchema.parse(
    submission.formVersion.definition,
  );
  const editable = editableAttendeeFields(
    definition,
    registration.event.attendeeEditPolicy,
  );
  const editableKeys = new Set(editable.map((field) => field.key));
  const seminarKeys = new Set(
    definition.sections
      .flatMap((section) => section.fields)
      .filter(isSeminarPreferenceField)
      .map((field) => field.key),
  );
  const currentById = new Map(
    registration.attendees.map((attendee) => [attendee.id, attendee]),
  );
  const seen = new Set<string>();
  const prepared = input.attendees.map((attendeeInput) => {
    if (seen.has(attendeeInput.attendeeId)) {
      throw new AttendeeAnswerUpdateError(
        "INVALID_ANSWER",
        "Each attendee can be updated only once per request.",
      );
    }
    seen.add(attendeeInput.attendeeId);
    const attendee = currentById.get(attendeeInput.attendeeId);
    if (!attendee) {
      throw new AttendeeAnswerUpdateError(
        "INVALID_ANSWER",
        "One of the attendees changed after you opened the registration.",
      );
    }
    const currentResponses = recordFromJson(attendee.formResponses);
    const preparedUpdate = prepareTieredAttendeeAnswerUpdate({
      definition,
      policy: registration.event.attendeeEditPolicy,
      registrationResponses: recordFromJson(submission.responses),
      currentResponses,
      changes: attendeeInput.responses,
    });
    return {
      attendee,
      ...preparedUpdate,
      changedKeys: [...editableKeys].filter((key) => (
        !valuesEqual(currentResponses[key], preparedUpdate.responses[key])
      )),
    };
  });

  const changedFields = [...new Set(
    prepared.flatMap((update) => update.changedKeys),
  )].sort();
  const changedSeminarFields = changedFields.filter((key) => seminarKeys.has(key));
  if (changedFields.length > 0) {
    if (changedSeminarFields.length > 0) {
      const today = calendarDateInEventTimeZone(input.now, registration.event.timezone);
      if (
        registration.event.seminarPreferenceSelfServiceLocked
        || (
          registration.event.seminarPreferenceClosesOn
          && today > registration.event.seminarPreferenceClosesOn
        )
      ) {
        throw new AttendeeAnswerUpdateError(
          "SEMINAR_PREFERENCES_LOCKED",
          "Seminar preference self-service is closed. Contact the event team for help.",
        );
      }
      const lockedAssignments = await tx.programAttendeeAssignment.findMany({
        where: {
          attendeeIdSnapshot: {
            in: prepared
              .filter((update) => update.changedKeys.some((key) => seminarKeys.has(key)))
              .map((update) => update.attendee.id),
          },
          run: {
            eventId: registration.eventId,
            formVersionId: submission.formVersionId,
            fieldKeySnapshot: { in: changedSeminarFields },
            invalidatedAt: null,
            supersededBy: { none: {} },
          },
        },
        select: {
          attendeeIdSnapshot: true,
          run: { select: { fieldKeySnapshot: true } },
        },
      });
      if (lockedAssignments.some((assignment) => prepared.some((update) => (
        update.attendee.id === assignment.attendeeIdSnapshot
        && update.changedKeys.includes(assignment.run.fieldKeySnapshot)
      )))) {
        throw new AttendeeAnswerUpdateError(
          "FINAL_ASSIGNMENT_LOCKED",
          "A final seminar assignment is recorded. Contact the event team for help.",
        );
      }
    }
    for (const update of prepared) {
      if (update.changedKeys.length === 0) continue;
      await tx.registrationAttendee.update({
        where: { id: update.attendee.id },
        data: { formResponses: update.responses as Prisma.InputJsonValue },
      });
    }
    await tx.registration.update({
      where: { id: registration.id },
      data: { updatedAt: input.now },
    });
    const invalidated = await tx.programAssignmentRun.updateMany({
      where: {
        eventId: registration.eventId,
        formVersionId: submission.formVersionId,
        fieldKeySnapshot: { in: changedFields },
        invalidatedAt: null,
      },
      data: { invalidatedAt: input.now },
    });
    const result = {
      expectedUpdatedAt: input.now.toISOString(),
      attendees: prepared.map((update) => ({
        attendeeId: update.attendee.id,
        name: publicAttendeeName(
          update.attendee.profileSnapshot,
          update.attendee.person,
        ),
        responses: Object.fromEntries(
          Object.entries(update.responses).filter(([key]) => editableKeys.has(key)),
        ),
      })),
    };
    const queued = changedSeminarFields.length > 0
      ? await enqueueRegistrationUpdatedMessage(tx, {
          eventId: registration.eventId,
          registrationId: registration.id,
          correlationId: input.clientRequestId,
          transitionKey: `seminar-preferences:${input.clientRequestId}`,
          changeCategory: "SEMINAR_PREFERENCES",
        })
      : { pendingMessageIds: [] as string[] };
    await tx.auditLog.create({
      data: {
        eventId: registration.eventId,
        action: input.audit.action,
        entityType: "Registration",
        entityId: registration.id,
        correlationId: input.clientRequestId,
        summary: input.audit.summary(registration.confirmationCode),
        metadata: {
          ...input.audit.metadata,
          policy: registration.event.attendeeEditPolicy,
          attendeeCount: prepared.length,
          changedFields,
          changedAt: input.now.toISOString(),
          requestFingerprint,
          previousSeminarPreferences: prepared
            .filter((update) => update.changedKeys.some((key) => seminarKeys.has(key)))
            .map((update) => ({
              attendeeId: update.attendee.id,
              responses: Object.fromEntries(update.changedKeys
                .filter((key) => seminarKeys.has(key))
                .map((key) => [
                  key,
                  recordFromJson(update.attendee.formResponses)[key] ?? null,
                ])),
            })),
          newSeminarPreferences: prepared
            .filter((update) => update.changedKeys.some((key) => seminarKeys.has(key)))
            .map((update) => ({
              attendeeId: update.attendee.id,
              responses: Object.fromEntries(update.changedKeys
                .filter((key) => seminarKeys.has(key))
                .map((key) => [
                  key,
                  update.responses[key] ?? null,
                ])),
            })),
          invalidatedAssignmentRunCount: invalidated.count,
          response: result,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    return { ...result, pendingMessageIds: queued.pendingMessageIds };
  }

  return {
    expectedUpdatedAt: changedFields.length > 0
      ? input.now.toISOString()
      : registration.updatedAt.toISOString(),
    attendees: prepared.map((update) => ({
      attendeeId: update.attendee.id,
      name: publicAttendeeName(
        update.attendee.profileSnapshot,
        update.attendee.person,
      ),
      responses: Object.fromEntries(
        Object.entries(update.responses).filter(([key]) => editableKeys.has(key)),
      ),
    })),
    pendingMessageIds: [] as string[],
  };
}
