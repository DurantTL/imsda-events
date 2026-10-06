import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  submitClubRegistration: vi.fn(),
  amendClubRegistration: vi.fn(),
  eventFindFirst: vi.fn(),
  rosterFindMany: vi.fn(),
  draftUpdate: vi.fn(),
  draftFind: vi.fn(),
  draftCreate: vi.fn(),
  locationFindFirst: vi.fn(),
  teamSettingsFind: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// The attendee second step is covered in tests/club-second-step.test.ts; here it has been passed.
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: async () => ({ status: "ACTIVE" }) },
    attendeeSession: { findUnique: async () => ({ secondFactorVerifiedAt: new Date() }) },
    attendeePasskey: { count: async () => 0 },
    platformSettings: { findUnique: async () => ({ passkeyRpId: null }) },
    event: { findFirst: mocks.eventFindFirst },
    eventTeamSettings: { findUnique: mocks.teamSettingsFind },
    clubRosterMember: { findMany: mocks.rosterFindMany },
    clubRegistrationDraft: {
      update: mocks.draftUpdate,
      findUnique: mocks.draftFind,
      create: mocks.draftCreate,
    },
    eventLocation: { findFirst: mocks.locationFindFirst },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-registrations/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-registrations/repository")>("@/modules/club-registrations/repository");
  return { ...actual, submitClubRegistration: mocks.submitClubRegistration, amendClubRegistration: mocks.amendClubRegistration };
});

import { PUT as PUT_DRAFT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/draft/route";
import { PATCH as EDIT, POST as SUBMIT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/registration/route";
import { ClubRegistrationError } from "@/modules/club-registrations/repository";
import { RegistrationAmendmentError } from "@/modules/registrations/amendments-repository";

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
    // A draft save always names its base revision and save id.
    body: JSON.stringify(method === "PUT" && body && typeof body === "object" ? { baseRevision: 1, saveId: "save-00000001", ...body } : body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([clubA, clubB]);
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.submitClubRegistration.mockResolvedValue({ confirmationCode: "REG-1" });
  mocks.amendClubRegistration.mockResolvedValue({
    result: { confirmationCode: "REG-1", updatedAt: "2026-10-15T13:00:00.000Z", attendeeCount: 2 },
    pendingMessageIds: [],
  });
  mocks.eventFindFirst.mockResolvedValue({ id: "event-1", startsAt: new Date("2026-12-05T15:00:00Z") });
  mocks.rosterFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
  mocks.draftUpdate.mockResolvedValue({ updatedAt: new Date("2026-10-01T00:00:00Z"), revision: 2, lastSaveId: "save-00000001" });
  mocks.draftFind.mockResolvedValue({ id: "draft-1" });
  mocks.draftCreate.mockResolvedValue({ updatedAt: new Date("2026-10-01T00:00:00Z"), revision: 1, lastSaveId: "save-00000001" });
  mocks.locationFindFirst.mockResolvedValue({ id: "loc-1" });
  // An event without team rules, unless a test says otherwise.
  mocks.teamSettingsFind.mockResolvedValue(null);
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
    expect(mocks.draftUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.submitClubRegistration).not.toHaveBeenCalled();
  });

  const edit = {
    clientRequestId: "2f0e3c1a-7a55-4c43-8e1c-2f6f6f4a9a10",
    expectedUpdatedAt: "2026-10-15T12:00:00.000Z",
    selectedMemberIds: ["m1"],
    keptGuestIds: [],
    keptOffRosterAttendeeIds: [],
    newGuests: [],
    attendeeResponses: {},
  };

  it("reopens and amends a submitted club registration for a current director", async () => {
    const response = await EDIT(request("PATCH", edit), ctx("club-a"));
    expect(response.status).toBe(200);
    expect(mocks.amendClubRegistration).toHaveBeenCalledWith("club-a", "event-1", { accountId: "director-1" }, { ...edit, rosterAges: {}, saveAgeToRosterIds: [] });
    // Only the club summary, never the staff view of the registration (B3).
    await expect(response.json()).resolves.toEqual({ confirmationCode: "REG-1", updatedAt: "2026-10-15T13:00:00.000Z", attendeeCount: 2 });
  });

  it("requires the client to say who off the roster is kept, so nobody is dropped by omission", async () => {
    const withoutKept: Partial<typeof edit> = { ...edit };
    delete withoutKept.keptOffRosterAttendeeIds;
    expect((await EDIT(request("PATCH", withoutKept), ctx("club-a"))).status).toBe(400);
    expect(mocks.amendClubRegistration).not.toHaveBeenCalled();
  });

  it("gives a director their own wording and no staff-only details for engine refusals", async () => {
    mocks.amendClubRegistration.mockRejectedValueOnce(new RegistrationAmendmentError(
      "PAYMENT_ADJUSTMENT_REQUIRED",
      "Record the required refund or adjustment in Finance before completing this amendment.",
      [],
      { paidCents: 12500, proposedTotalCents: 5000, preview: { lineItems: [{ label: "Staff-only line" }] } },
    ));
    const payment = await EDIT(request("PATCH", edit), ctx("club-a"));
    expect(payment.status).toBe(409);
    expect(await payment.json()).toEqual({
      error: "PAYMENT_ADJUSTMENT_REQUIRED",
      message: "This change would lower what your church owes below what's already paid. Ask the event team.",
      issues: [],
    });

    mocks.amendClubRegistration.mockRejectedValueOnce(new RegistrationAmendmentError(
      "ATTENDEE_HAS_HISTORY",
      "Jordan Example cannot be removed because check-in or substitution history is attached.",
      [],
      { attendeeId: "attendee-m2", attendeeName: "Jordan Example" },
    ));
    const history = await EDIT(request("PATCH", edit), ctx("club-a"));
    const historyBody = await history.json();
    expect(historyBody.message).toBe("Jordan Example has already checked in or been substituted, so they can't be removed here. Tick them again to keep them, or ask the event team.");
    expect(historyBody).not.toHaveProperty("details");

    mocks.amendClubRegistration.mockRejectedValueOnce(new RegistrationAmendmentError(
      "INVALID_AMENDMENT",
      "Review the highlighted registration and attendee fields.",
      [{ kind: "validation", code: "INVALID_RESPONSE", fieldId: "a_shirt", key: "shirt_size", path: "attendees.1.responses.shirt_size", attendeeIndex: 1, message: "Shirt size is required.", clientId: "member:m3" } as never],
    ));
    const invalid = await EDIT(request("PATCH", edit), ctx("club-a"));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      error: "INVALID_AMENDMENT",
      message: "Review the highlighted answers and try again.",
      issues: [{ key: "shirt_size", message: "Shirt size is required.", clientId: "member:m3" }],
    });
  });

  it("stops a director whose grant was revoked from reopening the registration (H3b, #366)", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubB]);
    expect((await EDIT(request("PATCH", edit), ctx("club-a"))).status).toBe(404);
    expect(mocks.amendClubRegistration).not.toHaveBeenCalled();
  });

  it("maps a closed-registration edit to a clear refusal", async () => {
    mocks.amendClubRegistration.mockRejectedValue(
      new ClubRegistrationError("REGISTRATION_CLOSED", "Registration for this event is closed."),
    );
    const response = await EDIT(request("PATCH", edit), ctx("club-a"));
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: "REGISTRATION_CLOSED" });
  });

  it("rejects a malformed edit request", async () => {
    expect((await EDIT(request("PATCH", { ...edit, selectedMemberIds: "m1" }), ctx("club-a"))).status).toBe(400);
    expect(mocks.amendClubRegistration).not.toHaveBeenCalled();
  });

  it("saves drafts only with people on this club's active roster", async () => {
    const response = await PUT_DRAFT(request("PUT", { selectedMemberIds: ["m1", "someone-else"], responses: {}, attendeeResponses: {} }), ctx("club-a"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "MEMBER_NOT_ON_ROSTER" });
    expect(mocks.rosterFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "club-a", status: "ACTIVE" }) }));

    await PUT_DRAFT(request("PUT", { selectedMemberIds: ["m1"], responses: { email: "x@example.test" }, attendeeResponses: { m1: { dietary_needs: "None" }, intruder: { note: "x" } } }), ctx("club-a"));
    expect(mocks.draftUpdate.mock.calls[0][0].data.attendeeResponses).toEqual({ m1: { dietary_needs: "None" } });
  });

  describe("draft revisions and location (#659)", () => {
    const body = { selectedMemberIds: ["m1"], responses: {}, attendeeResponses: {} };
    const missed = () => Object.assign(new Error("No record found"), { code: "P2025" });
    const row = (revision: number, lastSaveId: string | null) => ({ id: "draft-1", updatedAt: new Date("2026-10-01T00:00:00Z"), revision, lastSaveId });

    it("saves against the revision the page loaded, in one statement, and returns the new one", async () => {
      const response = await PUT_DRAFT(request("PUT", { ...body, baseRevision: 1 }), ctx("club-a"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ revision: 2 });
      const call = mocks.draftUpdate.mock.calls[0][0];
      expect(call.where).toMatchObject({ eventId_organizationId_draftKey: { eventId: "event-1", organizationId: "club-a", draftKey: "" }, revision: 1 });
      expect(call.data.revision).toEqual({ increment: 1 });
      expect(call.data.lastSaveId).toBe("save-00000001");
    });

    it("requires the base revision and save id", async () => {
      const bare = { ...body };
      const raw = new Request("https://events.imsda.test/x", {
        method: "PUT",
        headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
        body: JSON.stringify(bare),
      });
      expect((await PUT_DRAFT(raw, ctx("club-a"))).status).toBe(400);
      expect(mocks.draftUpdate).not.toHaveBeenCalled();
    });

    it("refuses a stale save from a second tab without overwriting", async () => {
      mocks.draftUpdate.mockRejectedValue(missed());
      mocks.draftFind.mockResolvedValue(row(5, "another-tab-save"));
      const response = await PUT_DRAFT(request("PUT", { ...body, baseRevision: 2 }), ctx("club-a"));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "DRAFT_CONFLICT" });
      expect(mocks.draftCreate).not.toHaveBeenCalled();
    });

    it("treats a retry of a commit whose response was lost as success, not a conflict", async () => {
      // The first attempt landed (revision 1 to 2, save id kept) but its response never arrived.
      mocks.draftUpdate.mockRejectedValue(missed());
      mocks.draftFind.mockResolvedValue(row(2, "save-00000001"));
      const retry = await PUT_DRAFT(request("PUT", { ...body, baseRevision: 1, saveId: "save-00000001" }), ctx("club-a"));
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({ revision: 2 });
      // Same save id but the draft has moved on since: that is a conflict.
      mocks.draftFind.mockResolvedValue(row(3, "save-00000001"));
      expect((await PUT_DRAFT(request("PUT", { ...body, baseRevision: 1, saveId: "save-00000001" }), ctx("club-a"))).status).toBe(409);
    });

    it("creates the first draft only for a page that loaded with none", async () => {
      mocks.draftUpdate.mockRejectedValue(missed());
      mocks.draftFind.mockResolvedValue(null);
      expect((await PUT_DRAFT(request("PUT", { ...body, baseRevision: 0 }), ctx("club-a"))).status).toBe(200);
      expect(mocks.draftCreate.mock.calls[0][0].data).toMatchObject({ revision: 1, lastSaveId: "save-00000001" });
    });

    it("does not bring back a draft that was submitted or deleted", async () => {
      mocks.draftUpdate.mockRejectedValue(missed());
      mocks.draftFind.mockResolvedValue(null);
      const response = await PUT_DRAFT(request("PUT", { ...body, baseRevision: 3 }), ctx("club-a"));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "DRAFT_CONFLICT" });
      expect(mocks.draftCreate).not.toHaveBeenCalled();
    });

    it("refuses the tab that loses a simultaneous first save, but accepts its own lost-response retry", async () => {
      mocks.draftUpdate.mockRejectedValue(missed());
      mocks.draftFind.mockResolvedValueOnce(null).mockResolvedValueOnce(row(1, "someone-else"));
      mocks.draftCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
      expect((await PUT_DRAFT(request("PUT", { ...body, baseRevision: 0 }), ctx("club-a"))).status).toBe(409);
      mocks.draftFind.mockResolvedValueOnce(null).mockResolvedValueOnce(row(1, "save-00000001"));
      expect((await PUT_DRAFT(request("PUT", { ...body, baseRevision: 0 }), ctx("club-a"))).status).toBe(200);
    });

    it("keeps the chosen location only when it is an active location of this event", async () => {
      await PUT_DRAFT(request("PUT", { ...body, locationId: "loc-1" }), ctx("club-a"));
      expect(mocks.locationFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "loc-1", eventId: "event-1", isActive: true } }));
      expect(mocks.draftUpdate.mock.calls[0][0].data.locationId).toBe("loc-1");
      mocks.locationFindFirst.mockResolvedValue(null);
      await PUT_DRAFT(request("PUT", { ...body, locationId: "elsewhere" }), ctx("club-a"));
      expect(mocks.draftUpdate.mock.calls[1][0].data.locationId).toBeNull();
    });
  });

  it("keeps typed-in ages in the draft only for going people with no birth date on file (#639)", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      { id: "m1", sealedBirthDate: "sealed" },
      { id: "m2", sealedBirthDate: null },
      { id: "m3", sealedBirthDate: null },
    ]);
    const body = { selectedMemberIds: ["m1", "m2"], responses: {}, attendeeResponses: {} };
    const response = await PUT_DRAFT(request("PUT", { ...body, rosterAges: { m1: 40, m2: 12, m3: 9 } }), ctx("club-a"));
    expect(response.status).toBe(200);
    expect(mocks.draftUpdate.mock.calls[0][0].data.rosterAges).toEqual({ m2: 12 });
  });

  it("keeps a save-back opt-out only for people whose age is kept in the draft (#639)", async () => {
    mocks.rosterFindMany.mockResolvedValue([{ id: "m1", sealedBirthDate: null }, { id: "m2", sealedBirthDate: null }]);
    const body = { selectedMemberIds: ["m1", "m2"], responses: {}, attendeeResponses: {}, rosterAges: { m1: 12 } };
    expect((await PUT_DRAFT(request("PUT", { ...body, rosterAgeSaveOff: ["m1", "m2"] }), ctx("club-a"))).status).toBe(200);
    expect(mocks.draftUpdate.mock.calls[0][0].data.rosterAgeSaveOff).toEqual(["m1"]);
  });

  it("rejects typed-in ages that are not whole numbers from 0 to 120 (#639)", async () => {
    const body = { selectedMemberIds: ["m1"], responses: {}, attendeeResponses: {} };
    for (const age of [121, -1, 4.5, "12"]) {
      expect((await PUT_DRAFT(request("PUT", { ...body, rosterAges: { m1: age } }), ctx("club-a"))).status).toBe(400);
    }
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
  });

  it("rejects cross-origin writes and malformed drafts", async () => {
    expect((await PUT_DRAFT(request("PUT", { selectedMemberIds: "m1" }), ctx("club-a"))).status).toBe(400);
    mocks.getCurrentAttendee.mockClear();
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await SUBMIT(request("POST", submission), ctx("club-a"))).status).toBe(403);
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
  });
});

describe("club registration routes for named teams (#809)", () => {
  const teamEvent = { eventId: "event-1", allowMultipleTeams: true, minTeamMembers: null, maxTeamMembers: null, maxAlternates: 0, ageAsOf: null, maxMemberAge: null, booksLine: "", levelInfo: [], createdAt: new Date(), updatedAt: new Date() };
  const body = { selectedMemberIds: ["m1"], responses: {}, attendeeResponses: {} };

  beforeEach(() => mocks.teamSettingsFind.mockResolvedValue(teamEvent));

  it("saves each team's draft under the id the page picked, with the name typed so far", async () => {
    const response = await PUT_DRAFT(request("PUT", { ...body, draftKey: "a1b2c3d4e5f60718", teamName: "Bible Bees" }), ctx("club-a"));
    expect(response.status).toBe(200);
    const call = mocks.draftUpdate.mock.calls[0]![0];
    expect(call.where).toMatchObject({ eventId_organizationId_draftKey: { eventId: "event-1", organizationId: "club-a", draftKey: "a1b2c3d4e5f60718" } });
    expect(call.data.teamName).toBe("Bible Bees");
  });

  it("refuses a team draft with no id, or a malformed one", async () => {
    for (const draftKey of [undefined, "short", "has spaces!!"]) {
      const response = await PUT_DRAFT(request("PUT", { ...body, ...(draftKey ? { draftKey } : {}), teamName: "Bible Bees" }), ctx("club-a"));
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: "TEAM_INVALID" });
    }
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
  });

  it("refuses a draft id on an event that takes one registration per club", async () => {
    mocks.teamSettingsFind.mockResolvedValue(null);
    const response = await PUT_DRAFT(request("PUT", { ...body, draftKey: "a1b2c3d4e5f60718" }), ctx("club-a"));
    expect(response.status).toBe(422);
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
  });

  it("sends the team's name and draft id beside the answers, never inside them", async () => {
    await SUBMIT(request("POST", { ...submission, teamName: "Bible Bees", draftKey: "a1b2c3d4e5f60718" }), ctx("club-a"));
    const [, , , input, , options] = mocks.submitClubRegistration.mock.calls[0]!;
    expect(options).toMatchObject({ teamName: "Bible Bees", draftKey: "a1b2c3d4e5f60718" });
    expect(input).not.toHaveProperty("teamName");
  });

  it("sends no team for a registration that names none", async () => {
    await SUBMIT(request("POST", submission), ctx("club-a"));
    const [, , , , , options] = mocks.submitClubRegistration.mock.calls[0]!;
    expect(options).toMatchObject({ teamName: null });
    expect(options).not.toHaveProperty("draftKey");
  });

  it("answers a taken team name with a clear 409", async () => {
    const { PublicRegistrationError } = await import("@/modules/forms/public-repository");
    mocks.submitClubRegistration.mockRejectedValue(new PublicRegistrationError("CLUB_TEAM_NAME_TAKEN", 'A team named "Bible Bees" is already registered for this event. Choose a different team name.'));
    const response = await SUBMIT(request("POST", { ...submission, teamName: "Bible Bees", draftKey: "a1b2c3d4e5f60718" }), ctx("club-a"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "CLUB_TEAM_NAME_TAKEN", message: expect.stringContaining("already registered") });
  });

  it("edits the team the request names", async () => {
    const edit = {
      clientRequestId: "6f1d3c1a-1c55-4c43-8e1c-2f6f6f4a9a10", expectedUpdatedAt: "2026-10-15T12:00:00.000Z",
      selectedMemberIds: ["m1"], keptGuestIds: [], keptOffRosterAttendeeIds: [], newGuests: [], attendeeResponses: {},
    };
    expect((await EDIT(request("PATCH", { ...edit, teamKey: "bible bees" }), ctx("club-a"))).status).toBe(200);
    expect(mocks.amendClubRegistration.mock.calls[0]![3]).toMatchObject({ teamKey: "bible bees" });
  });
});
