import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  submitClubRegistration: vi.fn(),
  eventFindFirst: vi.fn(),
  rosterFindMany: vi.fn(),
  draftUpsert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: async () => ({ status: "ACTIVE" }) },
    attendeeSession: { findUnique: async () => ({ secondFactorVerifiedAt: new Date() }) },
    event: { findFirst: mocks.eventFindFirst },
    clubRosterMember: { findMany: mocks.rosterFindMany },
    clubRegistrationDraft: { upsert: mocks.draftUpsert },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-registrations/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-registrations/repository")>("@/modules/club-registrations/repository");
  return { ...actual, submitClubRegistration: mocks.submitClubRegistration };
});

import { PUT as PUT_DRAFT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/draft/route";
import { POST as SUBMIT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/registration/route";

const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const clubA = { organizationId: "club-a", name: "Club A", role: "DIRECTOR", sponsoringChurch: null };
const clubB = { organizationId: "club-b", name: "Club B", role: "DEPUTY", sponsoringChurch: null };
const ctx = (organizationId: string) => ({ params: Promise.resolve({ organizationId, eventId: "event-1" }) });
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
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([clubA, clubB]);
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.submitClubRegistration.mockResolvedValue({ confirmationCode: "REG-1" });
  mocks.eventFindFirst.mockResolvedValue({ id: "event-1", startsAt: new Date("2026-12-05T15:00:00Z") });
  mocks.rosterFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
  mocks.draftUpsert.mockResolvedValue({ updatedAt: new Date("2026-10-01T00:00:00Z") });
});

describe("club registration routes", () => {
  it("keeps a director of two clubs' registrations separate", async () => {
    await SUBMIT(request("POST", submission), ctx("club-a"));
    await SUBMIT(request("POST", submission), ctx("club-b"));
    expect(mocks.submitClubRegistration.mock.calls.map(([organizationId]) => organizationId)).toEqual(["club-a", "club-b"]);
    expect((await SUBMIT(request("POST", submission), ctx("club-c"))).status).toBe(404);
  });

  it("stops a director whose grant was revoked mid-draft", async () => {
    expect((await PUT_DRAFT(request("PUT", { selectedMemberIds: ["m1"], responses: {}, attendeeResponses: {} }), ctx("club-a"))).status).toBe(200);
    mocks.listDirectedClubs.mockResolvedValue([clubB]);
    expect((await PUT_DRAFT(request("PUT", { selectedMemberIds: ["m1", "m2"], responses: {}, attendeeResponses: {} }), ctx("club-a"))).status).toBe(404);
    expect((await SUBMIT(request("POST", submission), ctx("club-a"))).status).toBe(404);
    expect(mocks.draftUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.submitClubRegistration).not.toHaveBeenCalled();
  });

  it("saves drafts only with people on this club's active roster", async () => {
    const response = await PUT_DRAFT(request("PUT", { selectedMemberIds: ["m1", "someone-else"], responses: {}, attendeeResponses: {} }), ctx("club-a"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "MEMBER_NOT_ON_ROSTER" });
    expect(mocks.rosterFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "club-a", status: "ACTIVE" }) }));

    await PUT_DRAFT(request("PUT", { selectedMemberIds: ["m1"], responses: { email: "x@example.test" }, attendeeResponses: { m1: { dietary_needs: "None" }, intruder: { note: "x" } } }), ctx("club-a"));
    expect(mocks.draftUpsert.mock.calls[0][0].update.attendeeResponses).toEqual({ m1: { dietary_needs: "None" } });
  });

  it("rejects cross-origin writes and malformed drafts", async () => {
    expect((await PUT_DRAFT(request("PUT", { selectedMemberIds: "m1" }), ctx("club-a"))).status).toBe(400);
    mocks.getCurrentAttendee.mockClear();
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await SUBMIT(request("POST", submission), ctx("club-a"))).status).toBe(403);
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
  });
});
