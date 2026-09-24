import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  listRoster: vi.fn(),
  updateRosterMember: vi.fn(),
  removeRosterMember: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});
vi.mock("@/modules/club-rosters/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/repository")>("@/modules/club-rosters/repository");
  return { ...actual, listRoster: mocks.listRoster, updateRosterMember: mocks.updateRosterMember, removeRosterMember: mocks.removeRosterMember };
});

import { DELETE, PATCH } from "@/app/api/attendee/clubs/[organizationId]/roster/[memberId]/route";

const ctx = { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) };
const request = (method: string, body: unknown) => new Request("https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue({ state: "OPEN", accountId: "director-1" });
  mocks.listRoster.mockResolvedValue([]);
  mocks.updateRosterMember.mockResolvedValue(undefined);
  mocks.removeRosterMember.mockResolvedValue(undefined);
});

describe("editing a roster member (#424)", () => {
  it("needs Male or Female when gender is part of the edit", async () => {
    const response = await PATCH(request("PATCH", {
      firstName: "A", lastName: "B", birthDate: "2014-01-01", attendeeType: "YOUTH", role: "", classLevel: null, gender: null,
    }), ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: "Choose Male or Female." });
    expect(mocks.updateRosterMember).not.toHaveBeenCalled();
  });

  it("saves a full edit with Male or Female, defaulting a blank role to Pathfinder", async () => {
    const response = await PATCH(request("PATCH", {
      firstName: "A", lastName: "B", birthDate: "2014-01-01", attendeeType: "YOUTH", role: "", classLevel: null, gender: "MALE",
    }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", expect.objectContaining({ role: "Pathfinder", gender: "MALE" }), { accountId: "director-1" });
  });

  it("deactivates and reactivates by status alone, without needing gender", async () => {
    let response = await PATCH(request("PATCH", { status: "INACTIVE" }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", { status: "INACTIVE" }, { accountId: "director-1" });

    response = await PATCH(request("PATCH", { status: "ACTIVE" }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", { status: "ACTIVE" }, { accountId: "director-1" });
  });

  it("still removes a person with a confirmation, unaffected by the gender rule", async () => {
    const response = await DELETE(request("DELETE", { confirm: true }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.removeRosterMember).toHaveBeenCalledWith("club-1", "member-1", { accountId: "director-1" });
  });
});
