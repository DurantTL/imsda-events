import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  AttendeeAnswerUpdateError,
  editableAttendeeFields,
  prepareTieredAttendeeAnswerUpdate,
} from "@/modules/attendee-accounts/registration-answer-policy";
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
      event: { select: { attendeeEditPolicy: true } },
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
  if (changedFields.length > 0) {
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
    await tx.auditLog.create({
      data: {
        eventId: registration.eventId,
        action: input.audit.action,
        entityType: "Registration",
        entityId: registration.id,
        correlationId: randomUUID(),
        summary: input.audit.summary(registration.confirmationCode),
        metadata: {
          ...input.audit.metadata,
          policy: registration.event.attendeeEditPolicy,
          attendeeCount: prepared.length,
          changedFields,
          invalidatedAssignmentRunCount: invalidated.count,
        },
      },
    });
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
  };
}
