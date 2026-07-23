import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => {
  class MockProgramAssignmentError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  }
  return {
    MockProgramAssignmentError,
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    requireProgramAssignmentAccess: vi.fn(),
    getProgramAssignmentPreview: vi.fn(),
    applyProgramAssignments: vi.fn(),
    getAppliedAssignmentRoster: vi.fn(),
  };
});

vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: dependencies.rejectCrossOriginRequest,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/program-assignments/access", () => ({
  requireProgramAssignmentAccess: dependencies.requireProgramAssignmentAccess,
}));
vi.mock("@/modules/program-assignments/repository", () => ({
  ProgramAssignmentError: dependencies.MockProgramAssignmentError,
  getProgramAssignmentPreview: dependencies.getProgramAssignmentPreview,
  applyProgramAssignments: dependencies.applyProgramAssignments,
  getAppliedAssignmentRoster: dependencies.getAppliedAssignmentRoster,
}));

import {
  GET as previewAssignments,
  POST as applyAssignments,
} from "@/app/api/events/[eventId]/program-assignments/route";
import { GET as exportRoster } from "@/app/api/events/[eventId]/program-assignments/[runId]/roster/route";

const clientRequestId = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";
const preview = {
  sourceFingerprint: "a".repeat(64),
  summary: { assigned: 1, unassigned: 0 },
};
const run = {
  id: "run_one",
  summary: { assigned: 1, unassigned: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user_one" } });
  dependencies.requireProgramAssignmentAccess.mockResolvedValue({
    user: { id: "user_one" },
  });
  dependencies.rejectCrossOriginRequest.mockReturnValue(null);
  dependencies.getProgramAssignmentPreview.mockResolvedValue(preview);
  dependencies.applyProgramAssignments.mockResolvedValue(run);
  dependencies.getAppliedAssignmentRoster.mockResolvedValue({
    id: "run_one",
    eventName: "Retreat",
    formName: "Registration",
    formVersionNumber: 3,
    fieldLabel: "Friday seminar",
    appliedAt: "2026-06-02T10:00:00.000Z",
    appliedByName: "Admin",
    assignments: [{
      attendeeId: "attendee_one",
      registrationId: "registration_one",
      confirmationCode: "REG-ONE",
      submittedAt: "2026-06-01T10:00:00.000Z",
      attendeePosition: 0,
      stableOrder: 0,
      firstName: "=Formula",
      lastName: "Example",
      attendeeType: "Adult",
      preferences: ["Prayer"],
      assignedOption: "Prayer",
      preferenceRank: 1,
      outcome: "ASSIGNED",
      unassignedReason: null,
    }],
  });
});

describe("program assignment routes", () => {
  it("authorizes and returns an uncached read-only preview", async () => {
    const response = await previewAssignments(
      new Request(
        "https://events.imsda.test/api/events/event_one/program-assignments?formVersionId=version_one&fieldId=session_one",
      ),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(dependencies.requireProgramAssignmentAccess).toHaveBeenCalledWith(
      { user: { id: "user_one" } },
      "event_one",
      dependencies.findActiveMembership,
    );
    expect(dependencies.getProgramAssignmentPreview).toHaveBeenCalledWith(
      "event_one",
      { formVersionId: "version_one", fieldId: "session_one" },
    );
  });

  it("requires an exact fingerprint and client UUID for explicit apply", async () => {
    const response = await applyAssignments(
      new Request(
        "https://events.imsda.test/api/events/event_one/program-assignments",
        {
          method: "POST",
          headers: {
            origin: "https://events.imsda.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            formVersionId: "version_one",
            fieldId: "session_one",
            previewFingerprint: "a".repeat(64),
            clientRequestId,
          }),
        },
      ),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(201);
    expect(dependencies.applyProgramAssignments).toHaveBeenCalledWith(
      "event_one",
      {
        formVersionId: "version_one",
        fieldId: "session_one",
        previewFingerprint: "a".repeat(64),
        clientRequestId,
      },
      "user_one",
    );
  });

  it("rejects cross-origin apply before authorization or mutation", async () => {
    dependencies.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );
    const response = await applyAssignments(
      new Request(
        "https://events.imsda.test/api/events/event_one/program-assignments",
        { method: "POST" },
      ),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.requireProgramAssignmentAccess).not.toHaveBeenCalled();
    expect(dependencies.applyProgramAssignments).not.toHaveBeenCalled();
  });

  it("returns 409 when a reviewed source changed before apply", async () => {
    dependencies.applyProgramAssignments.mockRejectedValue(
      new dependencies.MockProgramAssignmentError(
        "SOURCE_CHANGED",
        "Preview again.",
        { currentFingerprint: "b".repeat(64) },
      ),
    );
    const response = await applyAssignments(
      new Request(
        "https://events.imsda.test/api/events/event_one/program-assignments",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formVersionId: "version_one",
            fieldId: "session_one",
            previewFingerprint: "a".repeat(64),
            clientRequestId,
          }),
        },
      ),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "SOURCE_CHANGED",
      details: { currentFingerprint: "b".repeat(64) },
    });
  });

  it("exports an event-authorized, formula-safe immutable roster", async () => {
    const response = await exportRoster(
      new Request(
        "https://events.imsda.test/api/events/event_one/program-assignments/run_one/roster",
      ),
      {
        params: Promise.resolve({
          eventId: "event_one",
          runId: "run_one",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(dependencies.getAppliedAssignmentRoster).toHaveBeenCalledWith(
      "event_one",
      "run_one",
    );
    expect(await response.text()).toContain("\"'=Formula\"");
  });
});
