import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { updateTieredRegistrationAnswersWithClient } from "@/modules/attendee-accounts/answer-update-repository";

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
    event: { attendeeEditPolicy: "TIERED" },
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
    auditLog: {
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
      },
      data: { invalidatedAt: now },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PRIVATE_LINK_ANSWERS_UPDATED",
        metadata: expect.objectContaining({
          changedFields: ["session_preferences"],
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
  });

  it("rejects a stale expected timestamp before writing", async () => {
    const { registration, tx } = fixture();
    await expect(updateTieredRegistrationAnswersWithClient(tx as never, {
      registrationId: registration.id,
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
});
