import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  listRoster: vi.fn(),
  updateRosterMember: vi.fn(),
  removeRosterMember: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
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
  return { ...actual, listRoster: mocks.listRoster, updateRosterMember: mocks.updateRosterMember, removeRosterMember: mocks.removeRosterMember };
});
vi.mock("@/modules/club-rosters/guardians-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/guardians-repository")>("@/modules/club-rosters/guardians-repository");
  return { ...actual, listGuardiansByMember: async () => ({}) };
});
vi.mock("@/modules/background-checks/refresh-after-write", () => ({ refreshBackgroundCheckMatchesSafely: mocks.refreshBackgroundCheckMatchesSafely }));

import { Prisma } from "@prisma/client";
import { DELETE, PATCH } from "@/app/api/attendee/clubs/[organizationId]/roster/[memberId]/route";
import { RosterOperationError } from "@/modules/club-rosters/repository";

const ctx = { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) };
const request = (method: string, body: unknown) => new Request("https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue({ state: "OPEN", capabilities: { guardians: false }, actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" } });
  mocks.listRoster.mockResolvedValue([]);
  mocks.updateRosterMember.mockResolvedValue({ personId: "person-1" });
  mocks.removeRosterMember.mockResolvedValue(undefined);
  mocks.refreshBackgroundCheckMatchesSafely.mockResolvedValue(undefined);
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

  it("saves a full edit with Male or Female, leaving the blank-role default to the type on file", async () => {
    const response = await PATCH(request("PATCH", {
      firstName: "A", lastName: "B", birthDate: "2014-01-01", attendeeType: "YOUTH", role: "", classLevel: null, gender: "MALE",
    }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith(
      "club-1", "member-1", expect.objectContaining({ role: "", gender: "MALE" }), { accountId: "director-1" }, undefined, { requireGender: true },
    );
  });

  it("rejects a details edit that leaves out gender when none is on file", async () => {
    mocks.updateRosterMember.mockRejectedValueOnce(new RosterOperationError("GENDER_REQUIRED", "Choose Male or Female."));
    const response = await PATCH(request("PATCH", { firstName: "A", lastName: "B", role: "Counselor" }), ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "GENDER_REQUIRED", message: "Choose Male or Female." });
    expect(mocks.updateRosterMember).toHaveBeenCalledWith(
      "club-1", "member-1", { firstName: "A", lastName: "B", role: "Counselor" }, { accountId: "director-1" }, undefined, { requireGender: true },
    );
  });

  it("deactivates and reactivates by status alone, without needing gender", async () => {
    let response = await PATCH(request("PATCH", { status: "INACTIVE" }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", { status: "INACTIVE" }, { accountId: "director-1" }, undefined, { requireGender: true });

    response = await PATCH(request("PATCH", { status: "ACTIVE" }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", { status: "ACTIVE" }, { accountId: "director-1" }, undefined, { requireGender: true });
  });

  it("still removes a person with a confirmation, unaffected by the gender rule", async () => {
    const response = await DELETE(request("DELETE", { confirm: true }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.removeRosterMember).toHaveBeenCalledWith("club-1", "member-1", { accountId: "director-1" });
  });
});

describe("malformed bodies (#566)", () => {
  const empty = (method: string) => new Request("https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  });

  it("answers an empty DELETE body with 400 INVALID_JSON_BODY, not a 500", async () => {
    const response = await DELETE(empty("DELETE"), ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_JSON_BODY" });
    expect(mocks.removeRosterMember).not.toHaveBeenCalled();
  });

  it("answers a malformed non-empty body with 400 INVALID_JSON_BODY", async () => {
    const response = await DELETE(new Request("https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", {
      method: "DELETE",
      headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
      body: "{",
    }), ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_JSON_BODY" });
  });

  it("answers an empty PATCH body with 400 INVALID_JSON_BODY", async () => {
    const response = await PATCH(empty("PATCH"), ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_JSON_BODY" });
  });

  it("asks to retry when the club's order lock wait gives up", async () => {
    mocks.removeRosterMember.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `55P03`", { code: "P2010", clientVersion: "test", meta: { code: "55P03" } }));
    const response = await DELETE(request("DELETE", { confirm: true }), ctx);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "ROSTER_BUSY" });
  });
});
