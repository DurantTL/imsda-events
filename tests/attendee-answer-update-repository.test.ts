import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { enqueueRegistrationUpdatedMessage } = vi.hoisted(() => ({
  enqueueRegistrationUpdatedMessage: vi.fn().mockResolvedValue({
    pendingMessageIds: ["message-1"],
  }),
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationUpdatedMessage,
}));

import { updateTieredRegistrationAnswersWithClient } from "@/modules/attendee-accounts/answer-update-repository";

beforeEach(() => {
  enqueueRegistrationUpdatedMessage.mockClear();
});

const definition = {
  title: "Retreat",
  description: "",
  confirmationMessage: "Received.",
  sections: [{
    id: "sessions",
    title: "Sessions",
    description: "",
    fields: [{
      id: "session-one",
      key: "session_preferences",
      label: "Seminar preferences",
      helpText: "",
      type: "RANKED_CHOICE",
      scope: "ATTENDEE",
      required: true,
      options: ["Prayer", "Service"],
      minSelections: 2,
      maxSelections: 2,
      availabilityMode: "RANKED_INTEREST",
      choiceLimits: {},
    }],
  }],
};

function fixture() {
  const registration = {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-PRIVATE",
    updatedAt: new Date("2026-07-30T10:00:00.000Z"),
    event: {
      attendeeEditPolicy: "TIERED",
      timezone: "America/Chicago",
      seminarPreferenceClosesOn: "2026-08-15" as string | null,
      seminarPreferenceSelfServiceLocked: false,
    },
    publicFormSubmission: {
      responses: { immutable_registration_answer: "original" },
      formVersionId: "form-version-1",
      formVersion: { definition },
    },
    attendees: [{
      id: "attendee-1",
      formResponses: {
        session_preferences: ["Prayer", "Service"],
        immutable_protected_answer: "original",
      },
      profileSnapshot: { firstName: "Retreat", lastName: "Guest" },
      person: { firstName: "Canonical", lastName: "Person" },
    }],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: registration.id }]),
    registration: {
      findFirst: vi.fn().mockResolvedValue(registration),
      update: vi.fn().mockResolvedValue({ id: registration.id }),
    },
    registrationAttendee: {
      update: vi.fn().mockResolvedValue({ id: "attendee-1" }),
    },
    programAssignmentRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    programAttendeeAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  };
  return { registration, tx };
}

describe("tiered attendee answer updates", () => {
  it("updates current responses, preserves submission snapshots, and invalidates stale assignments", async () => {
    const { registration, tx } = fixture();
    const immutableSubmission = structuredClone(registration.publicFormSubmission);
    const now = new Date("2026-07-30T11:00:00.000Z");

    const result = await updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "a2f15c6b-c2e7-45fe-8d49-e8e8e80d41de",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now,
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    });

    expect(tx.registrationAttendee.update).toHaveBeenCalledWith({
      where: { id: "attendee-1" },
      data: {
        formResponses: {
          session_preferences: ["Service", "Prayer"],
          immutable_protected_answer: "original",
        },
      },
    });
    expect(registration.publicFormSubmission).toEqual(immutableSubmission);
    expect(tx.programAssignmentRun.updateMany).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        formVersionId: "form-version-1",
        fieldKeySnapshot: { in: ["session_preferences"] },
        invalidatedAt: null,
        assignments: {
          none: {
            attendeeIdSnapshot: { in: ["attendee-1"] },
            outcome: "ASSIGNED",
            optionValue: { not: null },
          },
        },
      },
      data: { invalidatedAt: now },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        correlationId: "a2f15c6b-c2e7-45fe-8d49-e8e8e80d41de",
        metadata: expect.objectContaining({
          changedFields: ["session_preferences"],
          previousSeminarPreferences: [{
            attendeeId: "attendee-1",
            responses: { session_preferences: ["Prayer", "Service"] },
          }],
          newSeminarPreferences: [{
            attendeeId: "attendee-1",
            responses: { session_preferences: ["Service", "Prayer"] },
          }],
          invalidatedAssignmentRunCount: 1,
        }),
      }),
    });
    expect(result).toMatchObject({
      expectedUpdatedAt: now.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
    });
    expect(enqueueRegistrationUpdatedMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        changeCategory: "SEMINAR_PREFERENCES",
        transitionKey: "seminar-preferences:a2f15c6b-c2e7-45fe-8d49-e8e8e80d41de",
        seminarPreferences: [{
          attendeeName: "Retreat Guest",
          seminarLabels: ["Service", "Prayer"],
        }],
      }),
    );
  });

  it("rejects a stale expected timestamp before writing", async () => {
    const { registration, tx } = fixture();
    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "b5dab067-1895-4e87-8808-ec4f02ead6eb",
      expectedUpdatedAt: "2026-07-29T10:00:00.000Z",
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-07-30T11:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    expect(tx.registrationAttendee.update).not.toHaveBeenCalled();
    expect(tx.programAssignmentRun.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("closes self-service after the event-timezone deadline", async () => {
    const { registration, tx } = fixture();

    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "7cfdcc22-0cc2-491c-9fbc-dda9c6e5d3b4",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-16T06:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    })).rejects.toMatchObject({ code: "SEMINAR_PREFERENCES_LOCKED" });
    expect(tx.registrationAttendee.update).not.toHaveBeenCalled();

    registration.event.seminarPreferenceClosesOn = null;
    registration.event.seminarPreferenceSelfServiceLocked = true;
    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "ef743666-82b8-4193-9387-1a06182ea87e",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-10T15:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    })).rejects.toMatchObject({ code: "SEMINAR_PREFERENCES_LOCKED" });
  });

  it("blocks an active assigned outcome but keeps an UNASSIGNED outcome editable", async () => {
    const { registration, tx } = fixture();
    tx.programAttendeeAssignment.findMany.mockResolvedValue([{
      attendeeIdSnapshot: "attendee-1",
      run: { fieldKeySnapshot: "session_preferences" },
    }]);

    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "7ec8c160-3675-41bb-bda1-aaf87f6087d7",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-10T15:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    })).rejects.toMatchObject({ code: "FINAL_ASSIGNMENT_LOCKED" });
    expect(tx.registrationAttendee.update).not.toHaveBeenCalled();
    expect(tx.programAttendeeAssignment.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        outcome: "ASSIGNED",
        optionValue: { not: null },
      }),
      select: expect.any(Object),
    });

    tx.programAttendeeAssignment.findMany.mockImplementation(async (args: {
      where: { outcome?: string; optionValue?: { not: null } };
    }) => (
      args.where.outcome === "ASSIGNED" && args.where.optionValue?.not === null
        ? []
        : [{
            attendeeIdSnapshot: "attendee-1",
            run: { fieldKeySnapshot: "session_preferences" },
          }]
    ));
    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "251c971a-e0f1-4086-ad4d-6bafcd28c8af",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-10T15:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    })).resolves.toMatchObject({
      attendees: [{ responses: { session_preferences: ["Service", "Prayer"] } }],
    });
  });

  it("returns the stored response on a retry without writing or emailing twice", async () => {
    const { registration, tx } = fixture();
    const input = {
      registrationId: registration.id,
      clientRequestId: "73ff34fb-3334-4a53-9f40-8e17051f6adb",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-10T15:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    };
    const first = await updateTieredRegistrationAnswersWithClient(tx as never, input);
    const metadata = tx.auditLog.create.mock.calls[0]![0].data.metadata;
    tx.auditLog.findFirst.mockResolvedValue({ metadata });
    const retried = await updateTieredRegistrationAnswersWithClient(tx as never, input);

    expect(retried).toMatchObject({
      expectedUpdatedAt: first!.expectedUpdatedAt,
      attendees: first!.attendees,
      pendingMessageIds: [],
    });
    expect(tx.registrationAttendee.update).toHaveBeenCalledOnce();
    expect(enqueueRegistrationUpdatedMessage).toHaveBeenCalledOnce();
  });

  it("retains assigned locks when an editable attendee saves seminar preferences", async () => {
    const { registration, tx } = fixture();
    registration.attendees.push({
      id: "attendee-2",
      formResponses: {
        session_preferences: ["Prayer", "Service"],
        immutable_protected_answer: "second-private-answer",
      },
      profileSnapshot: { firstName: "Second", lastName: "Guest" },
      person: { firstName: "Second", lastName: "Person" },
    });
    tx.programAttendeeAssignment.findMany.mockResolvedValue([{
      attendeeIdSnapshot: "attendee-1",
      run: { fieldKeySnapshot: "session_preferences" },
    }]);

    const result = await updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "8f32f746-8669-4400-a126-b78310aa842a",
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Prayer", "Service"] },
      }, {
        attendeeId: "attendee-2",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-10T15:00:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    });

    expect(result?.attendees).toEqual([
      expect.objectContaining({
        attendeeId: "attendee-1",
        lockedFieldKeys: ["session_preferences"],
      }),
      expect.objectContaining({
        attendeeId: "attendee-2",
        lockedFieldKeys: [],
        responses: { session_preferences: ["Service", "Prayer"] },
      }),
    ]);
    expect(tx.registrationAttendee.update).toHaveBeenCalledOnce();
  });

  it("accepts excess ranked interest when assignment room capacity is full", async () => {
    const { registration, tx } = fixture();
    definition.sections[0].fields[0].choiceLimits = { Prayer: 1, Service: 1 };
    try {
      await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
        registrationId: registration.id,
        clientRequestId: "7f915f2d-c67b-43bb-b0b5-36fa310f813f",
        expectedUpdatedAt: registration.updatedAt.toISOString(),
        attendees: [{
          attendeeId: "attendee-1",
          responses: { session_preferences: ["Service", "Prayer"] },
        }],
        now: new Date("2026-08-10T15:00:00.000Z"),
        audit: {
          action: "PRIVATE_LINK_ANSWERS_UPDATED",
          summary: () => "Private choices changed.",
          metadata: { source: "PRIVATE_MANAGE_LINK" },
        },
      })).resolves.toMatchObject({
        attendees: [{ responses: { session_preferences: ["Service", "Prayer"] } }],
      });
    } finally {
      definition.sections[0].fields[0].choiceLimits = {};
    }
  });

  it("serializes concurrent changes and rejects the stale contender", async () => {
    const { registration, tx } = fixture();
    registration.updatedAt = new Date("2026-08-10T15:01:00.000Z");

    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
      clientRequestId: "7ab6def9-8938-4ed3-a054-a760cd0381bf",
      expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
      now: new Date("2026-08-10T15:01:00.000Z"),
      audit: {
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        summary: () => "Private choices changed.",
        metadata: { source: "PRIVATE_MANAGE_LINK" },
      },
    })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    expect(tx.$queryRaw.mock.calls[0]?.[0].strings.join(" ")).toContain("FOR UPDATE");
    expect(tx.registrationAttendee.update).not.toHaveBeenCalled();
  });
});
