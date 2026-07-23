import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignmentSourceFingerprint } from "@/modules/program-assignments/domain";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  applyProgramAssignments,
  ProgramAssignmentError,
} from "@/modules/program-assignments/repository";

const clientRequestId = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";
const submittedAt = new Date("2026-06-01T10:00:00.000Z");
const definition = {
  title: "Retreat",
  description: "",
  confirmationMessage: "Received.",
  sections: [{
    id: "program_section",
    title: "Program",
    description: "",
    fields: [{
      id: "session_one",
      key: "session_one_preferences",
      label: "Friday seminar",
      helpText: "",
      type: "RANKED_CHOICE",
      scope: "ATTENDEE",
      required: true,
      options: ["Prayer", "Service"],
      minSelections: 1,
      maxSelections: 2,
      availabilityMode: "RANKED_INTEREST",
      choiceLimits: { Prayer: 1, Service: 2 },
    }],
  }],
};

function sourceFingerprint() {
  return assignmentSourceFingerprint({
    eventId: "event_one",
    formId: "form_one",
    formName: "Retreat",
    formVersionId: "version_one",
    formVersionNumber: 3,
    fieldId: "session_one",
    fieldKey: "session_one_preferences",
    fieldLabel: "Friday seminar",
    options: ["Prayer", "Service"],
    choiceLimits: { Prayer: 1, Service: 2 },
    participants: [{
      attendeeId: "attendee_one",
      registrationId: "registration_one",
      registrationStatus: "SUBMITTED",
      confirmationCode: "REG-ONE",
      submittedAt: submittedAt.toISOString(),
      attendeePosition: 0,
      firstName: "Ada",
      lastName: "Lovelace",
      attendeeType: "Adult",
      preferences: ["Prayer", "Service"],
    }],
  });
}

function appliedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_one",
    eventId: "event_one",
    formId: "form_one",
    formVersionId: "version_one",
    fieldId: "session_one",
    fieldKeySnapshot: "session_one_preferences",
    fieldLabelSnapshot: "Friday seminar",
    formNameSnapshot: "Retreat",
    formVersionNumber: 3,
    optionsSnapshot: ["Prayer", "Service"],
    limitsSnapshot: { Prayer: 1, Service: 2 },
    summarySnapshot: {
      attendees: 1,
      assigned: 1,
      firstChoiceAssigned: 1,
      secondChoiceAssigned: 0,
      lowerChoiceAssigned: 0,
      unassigned: 0,
      noRankedChoices: 0,
      limitedOptions: 2,
      unlimitedOptions: 0,
    },
    sourceFingerprint: sourceFingerprint(),
    sourceParticipantCount: 1,
    clientRequestId,
    appliedByUserId: "user_one",
    appliedByNameSnapshot: "Event Admin",
    supersedesRunId: null,
    appliedAt: new Date("2026-06-02T10:00:00.000Z"),
    createdAt: new Date("2026-06-02T10:00:00.000Z"),
    assignments: [{
      id: "assignment_one",
      runId: "run_one",
      attendeeIdSnapshot: "attendee_one",
      registrationIdSnapshot: "registration_one",
      confirmationCodeSnapshot: "REG-ONE",
      registrationSubmittedAt: submittedAt,
      attendeePositionSnapshot: 0,
      stableOrder: 0,
      firstNameSnapshot: "Ada",
      lastNameSnapshot: "Lovelace",
      attendeeTypeSnapshot: "Adult",
      preferencesSnapshot: ["Prayer", "Service"],
      optionValue: "Prayer",
      preferenceRank: 1,
      outcome: "ASSIGNED",
      unassignedReason: null,
      createdAt: new Date("2026-06-02T10:00:00.000Z"),
    }],
    event: { name: "Retreat event" },
    ...overrides,
  };
}

function fixture() {
  const run = appliedRun();
  const tx = {
    registrationFormVersion: {
      findFirst: vi.fn().mockResolvedValue({
        id: "version_one",
        versionNumber: 3,
        definition,
        form: { id: "form_one", name: "Retreat" },
      }),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([{
        id: "registration_one",
        status: "SUBMITTED",
        confirmationCode: "REG-ONE",
        submittedAt,
        attendees: [{
          id: "attendee_one",
          position: 0,
          attendeeType: "Adult",
          profileSnapshot: {
            firstName: "Ada",
            lastName: "Lovelace",
          },
          person: {
            firstName: "Mutable",
            lastName: "Person",
          },
        }],
        publicFormSubmission: {
          attendeeResponses: [{
            position: 0,
            identity: {
              firstName: "Ada",
              lastName: "Lovelace",
            },
            responses: {
              session_one_preferences: ["Prayer", "Service"],
              private_medical_note: "NEVER PERSIST THIS",
            },
          }],
        },
      }]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ displayName: "Event Admin" }),
    },
    programAssignmentRun: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(run),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_one" }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => operation(tx)),
    programAssignmentRun: {
      findFirst: vi.fn().mockResolvedValue(run),
    },
  };
  return { prisma, tx, run };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("program assignment repository", () => {
  it("recomputes and freezes the reviewed source inside a serializable transaction", async () => {
    const { prisma, tx } = fixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await applyProgramAssignments(
      "event_one",
      {
        formVersionId: "version_one",
        fieldId: "session_one",
        previewFingerprint: sourceFingerprint(),
        clientRequestId,
      },
      "user_one",
    );

    expect(result).toMatchObject({
      id: "run_one",
      sourceFingerprint: sourceFingerprint(),
      summary: { assigned: 1, unassigned: 0 },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    expect(tx.programAssignmentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientRequestId,
        supersedesRunId: null,
        assignments: {
          create: [expect.objectContaining({
            attendeeIdSnapshot: "attendee_one",
            optionValue: "Prayer",
            preferenceRank: 1,
            preferencesSnapshot: ["Prayer", "Service"],
          })],
        },
      }),
    });
    expect(JSON.stringify(tx.programAssignmentRun.create.mock.calls))
      .not.toContain("NEVER PERSIST THIS");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict and writes nothing when the exact source changed", async () => {
    const { prisma, tx } = fixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyProgramAssignments(
      "event_one",
      {
        formVersionId: "version_one",
        fieldId: "session_one",
        previewFingerprint: "a".repeat(64),
        clientRequestId,
      },
      "user_one",
    )).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
      details: {
        currentFingerprint: sourceFingerprint(),
      },
    } satisfies Partial<ProgramAssignmentError>);
    expect(tx.programAssignmentRun.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("replays the same client UUID without recomputing or auditing", async () => {
    const { prisma, tx, run } = fixture();
    tx.programAssignmentRun.findUnique.mockResolvedValue(run);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyProgramAssignments(
      "event_one",
      {
        formVersionId: "version_one",
        fieldId: "session_one",
        previewFingerprint: sourceFingerprint(),
        clientRequestId,
      },
      "user_one",
    )).resolves.toMatchObject({ id: "run_one" });
    expect(tx.registrationFormVersion.findFirst).not.toHaveBeenCalled();
    expect(tx.programAssignmentRun.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("recovers an idempotency unique-index race by returning the winning run", async () => {
    const { prisma, tx, run } = fixture();
    tx.programAssignmentRun.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(run);
    tx.programAssignmentRun.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "6.19.3" },
      ),
    );
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(applyProgramAssignments(
      "event_one",
      {
        formVersionId: "version_one",
        fieldId: "session_one",
        previewFingerprint: sourceFingerprint(),
        clientRequestId,
      },
      "user_one",
    )).resolves.toMatchObject({ id: "run_one" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("links a new immutable run to the prior run instead of overwriting it", async () => {
    const { prisma, tx } = fixture();
    tx.programAssignmentRun.findFirst.mockResolvedValue({ id: "run_prior" });
    dependencies.getPrisma.mockReturnValue(prisma);

    await applyProgramAssignments(
      "event_one",
      {
        formVersionId: "version_one",
        fieldId: "session_one",
        previewFingerprint: sourceFingerprint(),
        clientRequestId,
      },
      "user_one",
    );

    expect(tx.programAssignmentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ supersedesRunId: "run_prior" }),
    });
    expect(tx.programAssignmentRun).not.toHaveProperty("update");
  });
});
