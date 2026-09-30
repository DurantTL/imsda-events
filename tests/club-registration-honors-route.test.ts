import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  submitClubRegistration: vi.fn(),
  saveRegistrationHonorPicks: vi.fn(),
  eventFindFirst: vi.fn(),
  rosterFindMany: vi.fn(),
  draftUpdate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: async () => ({ status: "ACTIVE" }) },
    attendeeSession: { findUnique: async () => ({ secondFactorVerifiedAt: new Date() }) },
    attendeePasskey: { count: async () => 0 },
    platformSettings: { findUnique: async () => ({ passkeyRpId: null }) },
    event: { findFirst: mocks.eventFindFirst },
    clubRosterMember: { findMany: mocks.rosterFindMany },
    clubRegistrationDraft: { update: mocks.draftUpdate },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-registrations/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-registrations/repository")>("@/modules/club-registrations/repository");
  return { ...actual, submitClubRegistration: mocks.submitClubRegistration };
});
vi.mock("@/modules/honors/enrollment-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/enrollment-repository")>("@/modules/honors/enrollment-repository");
  return { ...actual, saveRegistrationHonorPicks: mocks.saveRegistrationHonorPicks };
});

import { PUT as PUT_DRAFT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/draft/route";
import { POST as SUBMIT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/registration/route";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";

const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const ctx = { params: Promise.resolve({ organizationId: "club-a", eventId: "event-1" }) };
const submission = {
  versionId: "version-1",
  idempotencyKey: "2f0e3c1a-7a55-4c43-8e1c-2f6f6f4a9a10",
  responses: { email: "director@example.test" },
  attendees: [{ clientId: "member:m1", responses: {} }],
};

function request(method: string, body: unknown) {
  return new Request("https://events.imsda.test/api/attendee/clubs/x/events/y", {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    // A draft save always names its base revision and save id (#659).
    body: JSON.stringify(method === "PUT" && body && typeof body === "object" ? { baseRevision: 1, saveId: "save-00000001", ...body } : body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-a", name: "Club A", role: "DIRECTOR", sponsoringChurch: null }]);
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.submitClubRegistration.mockResolvedValue({ confirmationCode: "REG-1" });
  mocks.saveRegistrationHonorPicks.mockResolvedValue({ saved: 1 });
  mocks.eventFindFirst.mockResolvedValue({ id: "event-1", startsAt: new Date("2026-12-05T15:00:00Z") });
  mocks.rosterFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
  mocks.draftUpdate.mockResolvedValue({ updatedAt: new Date("2026-10-01T00:00:00Z"), revision: 2, lastSaveId: "save-00000001" });
});

describe("honors picked during club registration (#618)", () => {
  it("submits the registration first, then saves the picks apart from the form answers", async () => {
    const response = await SUBMIT(request("POST", { ...submission, locationId: "loc-1", honorSelections: { "member:m1": ["knots"] } }), ctx);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ confirmation: { confirmationCode: "REG-1" }, honors: { saved: 1 } });
    // The picks never reach the form answers.
    expect(mocks.submitClubRegistration.mock.calls[0]![3]).not.toHaveProperty("honorSelections");
    expect(mocks.saveRegistrationHonorPicks).toHaveBeenCalledWith("club-a", "event-1", { accountId: "director-1" }, { "member:m1": ["knots"] });
  });

  it("does not look at honors when none were picked", async () => {
    const response = await SUBMIT(request("POST", submission), ctx);
    expect(response.status).toBe(201);
    expect(mocks.saveRegistrationHonorPicks).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ honors: null });
  });

  it("keeps the registration and says why when a class filled up meanwhile", async () => {
    mocks.saveRegistrationHonorPicks.mockRejectedValueOnce(new ClassSelectionError("CLASS_FULL", "Knots is full. Choose another class."));
    const response = await SUBMIT(request("POST", { ...submission, honorSelections: { "member:m1": ["knots"] } }), ctx);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      confirmation: { confirmationCode: "REG-1" },
      honors: { error: "Knots is full. Choose another class." },
    });
  });

  it("gives a director who submits picks for another club a 404, and touches nothing", async () => {
    const other = { params: Promise.resolve({ organizationId: "club-b", eventId: "event-1" }) };
    const response = await SUBMIT(request("POST", { ...submission, honorSelections: { "member:m1": ["knots"] } }), other);
    expect(response.status).toBe(404);
    expect(mocks.submitClubRegistration).not.toHaveBeenCalled();
    expect(mocks.saveRegistrationHonorPicks).not.toHaveBeenCalled();
  });

  it("does not re-apply picks when the submit was a replay of an earlier one", async () => {
    mocks.submitClubRegistration.mockImplementationOnce(async (...args: unknown[]) => {
      (args[5] as { report: (outcome: { replayed: boolean; waitlisted: boolean }) => void }).report({ replayed: true, waitlisted: false });
      return { confirmationCode: "REG-1" };
    });
    const response = await SUBMIT(request("POST", { ...submission, honorSelections: { "member:m1": ["knots"] } }), ctx);
    expect(response.status).toBe(201);
    expect(mocks.saveRegistrationHonorPicks).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ honors: null });
  });

  it("tells a waitlisted club that its honors weren't saved, and takes no seats", async () => {
    mocks.submitClubRegistration.mockImplementationOnce(async (...args: unknown[]) => {
      (args[5] as { report: (outcome: { replayed: boolean; waitlisted: boolean }) => void }).report({ replayed: false, waitlisted: true });
      return { confirmationCode: "REG-1", registrationStatus: "WAITLISTED" };
    });
    const response = await SUBMIT(request("POST", { ...submission, honorSelections: { "member:m1": ["knots"] } }), ctx);
    expect(response.status).toBe(201);
    expect(mocks.saveRegistrationHonorPicks).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      confirmation: { registrationStatus: "WAITLISTED" },
      honors: { error: expect.stringContaining("Pick classes after you're confirmed") },
    });
  });

  it("caps the draft's honor picks at 60 people", async () => {
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`member:m${index}`, ["knots"]]));
    const response = await PUT_DRAFT(request("PUT", {
      selectedMemberIds: ["m1"], guests: [], responses: {}, attendeeResponses: {}, honorSelections: many,
    }), ctx);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
  });

  it("saves picks in the draft only for people going, and refuses malformed ones", async () => {
    const ok = await PUT_DRAFT(request("PUT", {
      selectedMemberIds: ["m1"], guests: [], responses: {}, attendeeResponses: {},
      honorSelections: { "member:m1": ["knots"], "member:m2": ["birds"], "member:nobody": ["x"] },
    }), ctx);
    expect(ok.status).toBe(200);
    expect(mocks.draftUpdate.mock.calls[0]![0].data.honorSelections).toEqual({ "member:m1": ["knots"] });

    const bad = await PUT_DRAFT(request("PUT", {
      selectedMemberIds: ["m1"], guests: [], responses: {}, attendeeResponses: {},
      honorSelections: { "member:m1": "knots" },
    }), ctx);
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});
