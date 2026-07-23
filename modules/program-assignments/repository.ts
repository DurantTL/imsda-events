import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  getAvailabilityMode,
  registrationFormDefinitionSchema,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import {
  buildRankedAssignmentPreview,
  type AppliedAssignmentRoster,
  type RankedAssignmentSource,
  type RankedAttendeeAssignment,
} from "@/modules/program-assignments/domain";
import type {
  ApplyProgramAssignmentsInput,
  ProgramAssignmentSelection,
} from "@/modules/program-assignments/schemas";

type AssignmentClient = PrismaClient | Prisma.TransactionClient;

export type ProgramAssignmentErrorCode =
  | "FORM_VERSION_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "FIELD_NOT_ASSIGNABLE"
  | "SOURCE_CHANGED"
  | "IDEMPOTENCY_CONFLICT"
  | "ASSIGNMENT_CONFLICT"
  | "RUN_NOT_FOUND";

export class ProgramAssignmentError extends Error {
  constructor(
    public readonly code: ProgramAssignmentErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProgramAssignmentError";
  }
}

type JsonRecord = Record<string, unknown>;

function recordFromJson(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function recordsFromJson(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonRecord => (
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry))
      ))
    : [];
}

function textFromRecord(
  record: JsonRecord,
  key: string,
  fallback: string,
) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function assignmentField(
  definition: ReturnType<typeof registrationFormDefinitionSchema.parse>,
  fieldId: string,
) {
  return definition.sections
    .flatMap((section) => section.fields)
    .find((field) => field.id === fieldId);
}

function assertAssignableField(
  field: RegistrationFormField | undefined,
): asserts field is RegistrationFormField {
  if (!field) {
    throw new ProgramAssignmentError(
      "FIELD_NOT_FOUND",
      "That ranked-choice field is not in this published form version.",
    );
  }
  if (
    field.type !== "RANKED_CHOICE"
    || getAvailabilityMode(field) !== "RANKED_INTEREST"
    || field.scope !== "ATTENDEE"
  ) {
    throw new ProgramAssignmentError(
      "FIELD_NOT_ASSIGNABLE",
      "Choose an attendee-level ranked-choice field marked as ranked interest.",
      {
        fieldType: field.type,
        availabilityMode: getAvailabilityMode(field),
        scope: field.scope,
      },
    );
  }
}

async function loadAssignmentSource(
  client: AssignmentClient,
  eventId: string,
  selection: ProgramAssignmentSelection,
): Promise<RankedAssignmentSource> {
  const version = await client.registrationFormVersion.findFirst({
    where: {
      id: selection.formVersionId,
      publishedAt: { not: null },
      form: { eventId },
    },
    include: {
      form: { select: { id: true, name: true } },
    },
  });
  if (!version) {
    throw new ProgramAssignmentError(
      "FORM_VERSION_NOT_FOUND",
      "That published registration form version is not available for this event.",
    );
  }
  const definition = registrationFormDefinitionSchema.parse(version.definition);
  const field = assignmentField(definition, selection.fieldId);
  assertAssignableField(field);

  const registrations = await client.registration.findMany({
    where: {
      eventId,
      status: { in: ["SUBMITTED", "CONFIRMED"] },
      publicFormSubmission: { formVersionId: version.id },
    },
    orderBy: [
      { submittedAt: "asc" },
      { id: "asc" },
    ],
    select: {
      id: true,
      status: true,
      confirmationCode: true,
      submittedAt: true,
      attendees: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          position: true,
          attendeeType: true,
          profileSnapshot: true,
          person: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      publicFormSubmission: {
        select: { attendeeResponses: true },
      },
    },
  });

  const participants = registrations.flatMap((registration) => {
    // Prisma keeps the full enum type after filtering, so retain a runtime guard
    // before passing the narrower lifecycle states to the assignment engine.
    if (
      registration.status !== "SUBMITTED" &&
      registration.status !== "CONFIRMED"
    ) {
      return [];
    }
    const registrationStatus: "SUBMITTED" | "CONFIRMED" =
      registration.status;
    const responseSnapshots = recordsFromJson(
      registration.publicFormSubmission?.attendeeResponses,
    );
    return registration.attendees.map((attendee, index) => {
      const snapshot = responseSnapshots[index] ?? {};
      const responses = Object.prototype.hasOwnProperty.call(snapshot, "responses")
        ? recordFromJson(snapshot.responses)
        : snapshot;
      const identity = recordFromJson(snapshot.identity);
      const profile = recordFromJson(attendee.profileSnapshot);
      return {
        attendeeId: attendee.id,
        registrationId: registration.id,
        registrationStatus,
        confirmationCode: registration.confirmationCode,
        submittedAt: registration.submittedAt?.toISOString() ?? null,
        attendeePosition: attendee.position,
        firstName: textFromRecord(
          identity,
          "firstName",
          textFromRecord(profile, "firstName", attendee.person.firstName),
        ),
        lastName: textFromRecord(
          identity,
          "lastName",
          textFromRecord(profile, "lastName", attendee.person.lastName),
        ),
        attendeeType: attendee.attendeeType,
        preferences: responses[field.key],
      };
    });
  });

  return {
    eventId,
    formId: version.form.id,
    formName: version.form.name,
    formVersionId: version.id,
    formVersionNumber: version.versionNumber,
    fieldId: field.id,
    fieldKey: field.key,
    fieldLabel: field.label,
    options: field.options,
    choiceLimits: field.choiceLimits ?? {},
    participants,
  };
}

export async function getProgramAssignmentPreview(
  eventId: string,
  selection: ProgramAssignmentSelection,
  now = new Date(),
) {
  const source = await loadAssignmentSource(getPrisma(), eventId, selection);
  return buildRankedAssignmentPreview(source, now);
}

export type ProgramAssignmentWorkspaceField = {
  formId: string;
  formName: string;
  formVersionId: string;
  formVersionNumber: number;
  fieldId: string;
  fieldLabel: string;
  optionCount: number;
  limitedOptionCount: number;
  unlimitedOptionCount: number;
};

export type ProgramAssignmentDiagnostic = {
  formName: string;
  formVersionNumber: number;
  fieldLabel: string;
  reason: string;
};

function summaryFromJson(value: unknown) {
  const summary = recordFromJson(value);
  const numberValue = (key: string) => (
    typeof summary[key] === "number" ? summary[key] : 0
  );
  return {
    attendees: numberValue("attendees"),
    assigned: numberValue("assigned"),
    firstChoiceAssigned: numberValue("firstChoiceAssigned"),
    secondChoiceAssigned: numberValue("secondChoiceAssigned"),
    lowerChoiceAssigned: numberValue("lowerChoiceAssigned"),
    unassigned: numberValue("unassigned"),
    noRankedChoices: numberValue("noRankedChoices"),
    limitedOptions: numberValue("limitedOptions"),
    unlimitedOptions: numberValue("unlimitedOptions"),
  };
}

type RunForSerialization = {
  id: string;
  formVersionId: string;
  formVersionNumber: number;
  formNameSnapshot: string;
  fieldId: string;
  fieldLabelSnapshot: string;
  sourceFingerprint: string;
  clientRequestId: string;
  appliedByNameSnapshot: string;
  supersedesRunId: string | null;
  appliedAt: Date;
  summarySnapshot: unknown;
};

function serializeRun(run: RunForSerialization) {
  return {
    id: run.id,
    formVersionId: run.formVersionId,
    formVersionNumber: run.formVersionNumber,
    formName: run.formNameSnapshot,
    fieldId: run.fieldId,
    fieldLabel: run.fieldLabelSnapshot,
    sourceFingerprint: run.sourceFingerprint,
    clientRequestId: run.clientRequestId,
    appliedByName: run.appliedByNameSnapshot,
    supersedesRunId: run.supersedesRunId,
    appliedAt: run.appliedAt.toISOString(),
    summary: summaryFromJson(run.summarySnapshot),
  };
}

async function listAppliedRuns(client: AssignmentClient, eventId: string) {
  const runs = await client.programAssignmentRun.findMany({
    where: { eventId },
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      formVersionId: true,
      formVersionNumber: true,
      formNameSnapshot: true,
      fieldId: true,
      fieldLabelSnapshot: true,
      sourceFingerprint: true,
      clientRequestId: true,
      appliedByNameSnapshot: true,
      supersedesRunId: true,
      appliedAt: true,
      summarySnapshot: true,
    },
  });
  return runs.map(serializeRun);
}

export async function getProgramAssignmentWorkspace(eventId: string) {
  const prisma = getPrisma();
  const [versions, runs] = await Promise.all([
    prisma.registrationFormVersion.findMany({
      where: {
        publishedAt: { not: null },
        form: { eventId },
      },
      orderBy: [
        { form: { name: "asc" } },
        { versionNumber: "desc" },
      ],
      include: {
        form: { select: { id: true, name: true } },
      },
    }),
    listAppliedRuns(prisma, eventId),
  ]);

  const fields: ProgramAssignmentWorkspaceField[] = [];
  const diagnostics: ProgramAssignmentDiagnostic[] = [];
  for (const version of versions) {
    const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) {
      diagnostics.push({
        formName: version.form.name,
        formVersionNumber: version.versionNumber,
        fieldLabel: "Published form definition",
        reason: "This historic version could not be read safely.",
      });
      continue;
    }
    for (const field of parsed.data.sections.flatMap((section) => section.fields)) {
      if (
        field.type !== "RANKED_CHOICE"
        || getAvailabilityMode(field) !== "RANKED_INTEREST"
      ) continue;
      if (field.scope !== "ATTENDEE") {
        diagnostics.push({
          formName: version.form.name,
          formVersionNumber: version.versionNumber,
          fieldLabel: field.label,
          reason: "Registration-level rankings are shown as interest only; assignments require an attendee-level field.",
        });
        continue;
      }
      fields.push({
        formId: version.form.id,
        formName: version.form.name,
        formVersionId: version.id,
        formVersionNumber: version.versionNumber,
        fieldId: field.id,
        fieldLabel: field.label,
        optionCount: field.options.length,
        limitedOptionCount: field.options.filter((option) => (
          field.choiceLimits?.[option] !== undefined
        )).length,
        unlimitedOptionCount: field.options.filter((option) => (
          field.choiceLimits?.[option] === undefined
        )).length,
      });
    }
  }

  return { fields, diagnostics, runs };
}

function retryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

async function runSerializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
    }
  }
  throw new ProgramAssignmentError(
    "ASSIGNMENT_CONFLICT",
    "Another registration or assignment changed at the same time. Preview again before applying.",
  );
}

async function runById(
  client: AssignmentClient,
  eventId: string,
  runId: string,
) {
  return client.programAssignmentRun.findFirst({
    where: { id: runId, eventId },
    include: {
      assignments: {
        orderBy: { stableOrder: "asc" },
      },
      event: { select: { name: true } },
    },
  });
}

type StoredProgramAttendeeAssignment =
  NonNullable<Awaited<ReturnType<typeof runById>>>["assignments"][number];

function storedAssignment(
  assignment: StoredProgramAttendeeAssignment,
): RankedAttendeeAssignment {
  const preferences = Array.isArray(assignment.preferencesSnapshot)
    ? assignment.preferencesSnapshot.filter((value): value is string => typeof value === "string")
    : [];
  return {
    attendeeId: assignment.attendeeIdSnapshot,
    registrationId: assignment.registrationIdSnapshot,
    confirmationCode: assignment.confirmationCodeSnapshot,
    submittedAt: assignment.registrationSubmittedAt?.toISOString() ?? null,
    attendeePosition: assignment.attendeePositionSnapshot,
    stableOrder: assignment.stableOrder,
    firstName: assignment.firstNameSnapshot,
    lastName: assignment.lastNameSnapshot,
    attendeeType: assignment.attendeeTypeSnapshot,
    preferences,
    assignedOption: assignment.optionValue,
    preferenceRank: assignment.preferenceRank,
    outcome: assignment.outcome,
    unassignedReason: assignment.unassignedReason,
  };
}

export async function applyProgramAssignments(
  eventId: string,
  input: ApplyProgramAssignmentsInput,
  actorUserId: string,
) {
  const runId = await runSerializable(async (tx) => {
    const replay = await tx.programAssignmentRun.findUnique({
      where: {
        eventId_clientRequestId: {
          eventId,
          clientRequestId: input.clientRequestId,
        },
      },
    });
    if (replay) {
      if (
        replay.formVersionId !== input.formVersionId
        || replay.fieldId !== input.fieldId
        || replay.sourceFingerprint !== input.previewFingerprint
      ) {
        throw new ProgramAssignmentError(
          "IDEMPOTENCY_CONFLICT",
          "That apply request ID was already used for a different preview.",
        );
      }
      return replay.id;
    }

    const source = await loadAssignmentSource(tx, eventId, input);
    const preview = buildRankedAssignmentPreview(source);
    if (preview.sourceFingerprint !== input.previewFingerprint) {
      throw new ProgramAssignmentError(
        "SOURCE_CHANGED",
        "Registrations or room limits changed after this preview. Review the refreshed preview before applying.",
        {
          currentFingerprint: preview.sourceFingerprint,
          currentSummary: preview.summary,
        },
      );
    }
    const actor = await tx.user.findUnique({
      where: { id: actorUserId },
      select: { displayName: true },
    });
    if (!actor) {
      throw new ProgramAssignmentError(
        "ASSIGNMENT_CONFLICT",
        "The staff account could not be verified before applying.",
      );
    }
    const prior = await tx.programAssignmentRun.findFirst({
      where: {
        eventId,
        formVersionId: input.formVersionId,
        fieldId: input.fieldId,
      },
      orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const run = await tx.programAssignmentRun.create({
      data: {
        eventId,
        formId: preview.formId,
        formVersionId: preview.formVersionId,
        fieldId: preview.fieldId,
        fieldKeySnapshot: preview.fieldKey,
        fieldLabelSnapshot: preview.fieldLabel,
        formNameSnapshot: preview.formName,
        formVersionNumber: preview.formVersionNumber,
        optionsSnapshot: preview.choices.map((choice) => choice.option),
        limitsSnapshot: Object.fromEntries(preview.choices.map((choice) => [
          choice.option,
          choice.capacity,
        ])),
        summarySnapshot: preview.summary,
        sourceFingerprint: preview.sourceFingerprint,
        sourceParticipantCount: preview.summary.attendees,
        clientRequestId: input.clientRequestId,
        appliedByUserId: actorUserId,
        appliedByNameSnapshot: actor.displayName,
        supersedesRunId: prior?.id ?? null,
        assignments: {
          create: preview.assignments.map((assignment) => ({
            attendeeIdSnapshot: assignment.attendeeId,
            registrationIdSnapshot: assignment.registrationId,
            confirmationCodeSnapshot: assignment.confirmationCode,
            registrationSubmittedAt: assignment.submittedAt
              ? new Date(assignment.submittedAt)
              : null,
            attendeePositionSnapshot: assignment.attendeePosition,
            stableOrder: assignment.stableOrder,
            firstNameSnapshot: assignment.firstName,
            lastNameSnapshot: assignment.lastName,
            attendeeTypeSnapshot: assignment.attendeeType,
            preferencesSnapshot: assignment.preferences,
            optionValue: assignment.assignedOption,
            preferenceRank: assignment.preferenceRank,
            outcome: assignment.outcome,
            unassignedReason: assignment.unassignedReason,
          })),
        },
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "PROGRAM_ASSIGNMENTS_APPLIED",
        entityType: "ProgramAssignmentRun",
        entityId: run.id,
        correlationId: input.clientRequestId,
        summary: `Applied ${preview.fieldLabel}: ${preview.summary.assigned} assigned, ${preview.summary.unassigned} unassigned.`,
        metadata: {
          formVersionId: preview.formVersionId,
          formVersionNumber: preview.formVersionNumber,
          fieldId: preview.fieldId,
          sourceFingerprint: preview.sourceFingerprint,
          assigned: preview.summary.assigned,
          firstChoiceAssigned: preview.summary.firstChoiceAssigned,
          secondChoiceAssigned: preview.summary.secondChoiceAssigned,
          unassigned: preview.summary.unassigned,
          supersedesRunId: prior?.id ?? null,
          messagesSent: false,
          registrationsChanged: false,
        },
      },
    });
    return run.id;
  });

  const run = await runById(getPrisma(), eventId, runId);
  if (!run) {
    throw new ProgramAssignmentError(
      "RUN_NOT_FOUND",
      "The applied assignment run could not be reloaded.",
    );
  }
  return {
    ...serializeRun(run),
    assignments: run.assignments.map(storedAssignment),
  };
}

export async function getAppliedAssignmentRoster(
  eventId: string,
  runId: string,
): Promise<AppliedAssignmentRoster | null> {
  const run = await runById(getPrisma(), eventId, runId);
  if (!run) return null;
  return {
    id: run.id,
    eventName: run.event.name,
    formName: run.formNameSnapshot,
    formVersionNumber: run.formVersionNumber,
    fieldLabel: run.fieldLabelSnapshot,
    appliedAt: run.appliedAt.toISOString(),
    appliedByName: run.appliedByNameSnapshot,
    assignments: run.assignments.map(storedAssignment),
  };
}
