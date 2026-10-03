import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  listRoster: vi.fn(),
  addRosterMember: vi.fn(),
  updateRosterMember: vi.fn(),
  removeRosterMember: vi.fn(),
  listGuardiansByMember: vi.fn(),
  refreshBackgroundCheckMatchesSafely: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});
vi.mock("@/modules/club-rosters/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/repository")>("@/modules/club-rosters/repository");
  return {
    ...actual,
    listRoster: mocks.listRoster,
    addRosterMember: mocks.addRosterMember,
    updateRosterMember: mocks.updateRosterMember,
    removeRosterMember: mocks.removeRosterMember,
  };
});
vi.mock("@/modules/club-rosters/guardians-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/guardians-repository")>("@/modules/club-rosters/guardians-repository");
  return { ...actual, listGuardiansByMember: mocks.listGuardiansByMember };
});
vi.mock("@/modules/background-checks/refresh-after-write", () => ({ refreshBackgroundCheckMatchesSafely: mocks.refreshBackgroundCheckMatchesSafely }));

import { GET as getRoster, POST as postRoster } from "@/app/api/attendee/clubs/[organizationId]/roster/route";
import { DELETE as deleteMember, PATCH as patchMember } from "@/app/api/attendee/clubs/[organizationId]/roster/[memberId]/route";
import { RosterOperationError } from "@/modules/club-rosters/repository";
import { clubCapabilities, type ClubRole } from "@/modules/organizations/director-grants-domain";

const orgCtx = { params: Promise.resolve({ organizationId: "club-1" }) };
const memberCtx = { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) };

function accessFor(role: ClubRole) {
  return {
    state: "OPEN",
    club: { organizationId: "club-1", name: "Synthetic Club", role, sponsoringChurch: null },
    capabilities: clubCapabilities(role),
    actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" },
  };
}

const request = (method: string, body?: unknown) => new Request("https://events.imsda.test/api/attendee/clubs/club-1/roster", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const newMember = { firstName: "Test", lastName: "Youth", birthDate: "2014-12-06", attendeeType: "YOUTH", gender: "FEMALE" };
const guardians = [
  { name: "Synthetic Guardian", relationship: "Mother", email: "guardian@example.test", phone: "(555) 010-0101" },
  { name: "", relationship: "", email: "", phone: "" },
];
const storedGuardians = { "member-1": [{ position: 1, name: "Synthetic Guardian", relationship: "Mother", email: "guardian@example.test", phone: "(555) 010-0101" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.listRoster.mockResolvedValue([]);
  mocks.addRosterMember.mockResolvedValue({ memberId: "member-1", personId: "person-1" });
  mocks.updateRosterMember.mockResolvedValue({ personId: "person-1" });
  mocks.removeRosterMember.mockResolvedValue({ personId: null, nameKept: false });
  mocks.listGuardiansByMember.mockResolvedValue(storedGuardians);
  mocks.refreshBackgroundCheckMatchesSafely.mockResolvedValue(undefined);
});

describe("roster routes and guardian contacts (#510)", () => {
  it.each(["DIRECTOR", "DEPUTY"] as const)("lets a %s add and edit a member with guardians, and returns them", async (role) => {
    mocks.requireRosterAccess.mockResolvedValue(accessFor(role));
    let response = await postRoster(request("POST", { ...newMember, guardians }), orgCtx);
    expect(response.status).toBe(201);
    expect(mocks.addRosterMember).toHaveBeenCalledWith("club-1", expect.any(String), expect.objectContaining({ guardians: [expect.objectContaining({ name: "Synthetic Guardian" }), expect.any(Object)] }), { accountId: "account-1" });
    await expect(response.json()).resolves.toMatchObject({ guardians: storedGuardians });

    response = await patchMember(request("PATCH", { guardians }), memberCtx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", expect.objectContaining({ guardians: expect.any(Array) }), { accountId: "account-1" }, undefined, { requireGender: true });
    await expect(response.json()).resolves.toMatchObject({ guardians: storedGuardians });
  });

  it.each(["REGISTRAR"] as const)("refuses a %s who sends guardians with 403 and writes nothing", async (role) => {
    mocks.requireRosterAccess.mockResolvedValue(accessFor(role));
    let response = await postRoster(request("POST", { ...newMember, guardians }), orgCtx);
    expect(response.status).toBe(403);
    expect(mocks.addRosterMember).not.toHaveBeenCalled();
    response = await patchMember(request("PATCH", { guardians }), memberCtx);
    expect(response.status).toBe(403);
    expect(mocks.updateRosterMember).not.toHaveBeenCalled();
    // Even an empty set is a guardian change, so it is refused too.
    response = await patchMember(request("PATCH", { guardians: [] }), memberCtx);
    expect(response.status).toBe(403);
  });

  it("still lets a registrar add and edit everything else, and never sends them guardians", async () => {
    mocks.requireRosterAccess.mockResolvedValue(accessFor("REGISTRAR"));
    let response = await postRoster(request("POST", newMember), orgCtx);
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("guardians");
    response = await patchMember(request("PATCH", { role: "TLT" }), memberCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("guardians");
    response = await getRoster(request("GET"), orgCtx);
    expect(await response.json()).not.toHaveProperty("guardians");
    response = await deleteMember(request("DELETE", { confirm: true }), memberCtx);
    expect(await response.json()).not.toHaveProperty("guardians");
    expect(mocks.listGuardiansByMember).not.toHaveBeenCalled();
  });

  it("returns guardians on GET and after a removal for a director only", async () => {
    mocks.requireRosterAccess.mockResolvedValue(accessFor("DIRECTOR"));
    let response = await getRoster(request("GET"), orgCtx);
    await expect(response.json()).resolves.toMatchObject({ guardians: storedGuardians });
    mocks.listGuardiansByMember.mockResolvedValue({});
    response = await deleteMember(request("DELETE", { confirm: true }), memberCtx);
    await expect(response.json()).resolves.toMatchObject({ guardians: {} });
    expect(mocks.removeRosterMember).toHaveBeenCalledWith("club-1", "member-1", { accountId: "account-1" });
  });

  it("answers a crafted guardian edit against a prior-year member with the usual 409 roster error", async () => {
    mocks.requireRosterAccess.mockResolvedValue(accessFor("DIRECTOR"));
    mocks.updateRosterMember.mockRejectedValueOnce(new RosterOperationError("GUARDIANS_PRIOR_YEAR", "Guardian contacts can only be changed on the current club year's roster."));
    const response = await patchMember(request("PATCH", { guardians }), memberCtx);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "GUARDIANS_PRIOR_YEAR", message: expect.any(String) });
  });

  it("rejects a malformed guardian with 400 before anything is written", async () => {
    mocks.requireRosterAccess.mockResolvedValue(accessFor("DIRECTOR"));
    for (const bad of [{ email: "not-an-email" }, { phone: "abc" }]) {
      const response = await postRoster(request("POST", { ...newMember, guardians: [bad] }), orgCtx);
      expect(response.status).toBe(400);
    }
    const tooMany = await patchMember(request("PATCH", { guardians: [{}, {}, {}] }), memberCtx);
    expect(tooMany.status).toBe(400);
    expect(mocks.addRosterMember).not.toHaveBeenCalled();
    expect(mocks.updateRosterMember).not.toHaveBeenCalled();
  });
});
