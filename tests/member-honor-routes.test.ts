import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireHonorsAccess: vi.fn(),
  requireHonorsEditAccess: vi.fn(),
  listClubHonorsPage: vi.fn(),
  listActiveHonorOptions: vi.fn(),
  recordMemberHonorEntries: vi.fn(),
  listMemberHonorHistory: vi.fn(),
  auditClubHonorsExport: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/honors/member-honor-access", () => ({
  requireHonorsAccess: mocks.requireHonorsAccess,
  requireHonorsEditAccess: mocks.requireHonorsEditAccess,
}));
vi.mock("@/modules/honors/member-honor-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/member-honor-repository")>("@/modules/honors/member-honor-repository");
  return {
    ...actual,
    listClubHonorsPage: mocks.listClubHonorsPage,
    listActiveHonorOptions: mocks.listActiveHonorOptions,
    recordMemberHonorEntries: mocks.recordMemberHonorEntries,
    listMemberHonorHistory: mocks.listMemberHonorHistory,
    auditClubHonorsExport: mocks.auditClubHonorsExport,
  };
});
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { GET as CLUB_HONORS_GET, POST as CLUB_HONORS_POST } from "@/app/api/attendee/clubs/[organizationId]/honors/route";
import { GET as CSV_GET } from "@/app/api/attendee/clubs/[organizationId]/honors/csv/route";
import { GET as MEMBER_GET, POST as MEMBER_POST } from "@/app/api/attendee/clubs/[organizationId]/roster/[memberId]/honors/route";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberHonorError } from "@/modules/honors/member-honor-repository";

const ctx = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });
const memberCtx = (organizationId = "club-1", memberId = "member-1") => ({ params: Promise.resolve({ organizationId, memberId }) });
const getRequest = () => new Request("https://events.imsda.test/api/attendee/x");
const postRequest = (body: unknown) => new Request("https://events.imsda.test/api/attendee/x", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const rows = [{ memberId: "member-1", firstName: "Ada", lastName: "Lin", classLevel: "EXPLORER", honors: [] }];
const honors = [{ id: "honor-1", code: "AR-011", name: "Basic Rescue" }];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.listClubHonorsPage.mockResolvedValue(rows);
  mocks.listActiveHonorOptions.mockResolvedValue(honors);
  mocks.recordMemberHonorEntries.mockResolvedValue(undefined);
});

describe("GET club honors", () => {
  it("returns the club's honors for an editor, with readOnly false", async () => {
    mocks.requireHonorsAccess.mockResolvedValue({ mode: "EDIT", actor: { accountId: "acct-1" } });
    const response = await CLUB_HONORS_GET(getRequest(), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows, honors, readOnly: false });
  });

  it("returns the same data read-only for an Area Coordinator", async () => {
    mocks.requireHonorsAccess.mockResolvedValue({ mode: "READ", viewer: { accountId: "acct-ac" } });
    const response = await CLUB_HONORS_GET(getRequest(), ctx());
    expect(await response.json()).toMatchObject({ readOnly: true });
  });

  it("denies someone with no access to this club at all", async () => {
    mocks.requireHonorsAccess.mockRejectedValue(new RosterAccessError("NOT_FOUND", 404, "That club could not be found."));
    const response = await CLUB_HONORS_GET(getRequest(), ctx());
    expect(response.status).toBe(404);
  });
});

describe("POST club honors (bulk entry)", () => {
  it("records honors for many members in one call for a roster-capable role", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    const memberIds = Array.from({ length: 22 }, (_, index) => `member-${index}`);
    const response = await CLUB_HONORS_POST(postRequest({
      memberIds, honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "",
    }), ctx());
    expect(response.status).toBe(201);
    expect(mocks.recordMemberHonorEntries).toHaveBeenCalledWith("club-1", memberIds, expect.objectContaining({ honorId: "honor-1" }), { accountId: "acct-1" });
  });

  it("rejects a request from a role that can't edit the roster (e.g. a reporter)", async () => {
    mocks.requireHonorsEditAccess.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    const response = await CLUB_HONORS_POST(postRequest({ memberIds: ["m1"], honorId: "honor-1", status: "IN_PROGRESS" }), ctx());
    expect(response.status).toBe(403);
    expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();
  });

  it("answers 404 when a selected member is on another club's roster, and returns no rows", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    mocks.recordMemberHonorEntries.mockRejectedValue(new MemberHonorError("MEMBER_NOT_FOUND", "That member isn't on this club's roster."));
    const response = await CLUB_HONORS_POST(postRequest({ memberIds: ["m1", "member-of-club-2"], honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "" }), ctx());
    expect(response.status).toBe(404);
    expect(mocks.recordMemberHonorEntries).toHaveBeenCalledWith("club-1", ["m1", "member-of-club-2"], expect.anything(), { accountId: "acct-1" });
    expect(mocks.listClubHonorsPage).not.toHaveBeenCalled();
  });

  it("rejects an empty selection before ever calling the repository", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    const response = await CLUB_HONORS_POST(postRequest({ memberIds: [], honorId: "honor-1", status: "IN_PROGRESS" }), ctx());
    expect(response.status).toBe(400);
    expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();
  });

  it("accepts a completed honor with the completion date omitted or blank (#790)", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    for (const body of [
      { memberIds: ["m1", "m2"], honorId: "honor-1", status: "COMPLETED" },
      { memberIds: ["m1", "m2"], honorId: "honor-1", status: "COMPLETED", completionDate: "" },
    ]) {
      const response = await CLUB_HONORS_POST(postRequest(body), ctx());
      expect(response.status).toBe(201);
    }
    expect(mocks.recordMemberHonorEntries).toHaveBeenCalledTimes(2);
    expect(mocks.recordMemberHonorEntries).toHaveBeenLastCalledWith("club-1", ["m1", "m2"], expect.objectContaining({ status: "COMPLETED", completionDate: "" }), { accountId: "acct-1" });
  });

  it("refuses a malformed completion date as 400 before the repository", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    const response = await CLUB_HONORS_POST(postRequest({ memberIds: ["m1"], honorId: "honor-1", status: "COMPLETED", completionDate: "last Tuesday" }), ctx());
    expect(response.status).toBe(400);
    expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();
  });

  it("surfaces an invalid entry (a future or impossible date) as 400", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    mocks.recordMemberHonorEntries.mockRejectedValue(new MemberHonorError("ENTRY_INVALID", "The completion date can't be in the future."));
    const response = await CLUB_HONORS_POST(postRequest({ memberIds: ["m1"], honorId: "honor-1", status: "COMPLETED", completionDate: "2999-01-01" }), ctx());
    expect(response.status).toBe(400);
  });
});

describe("CSV export", () => {
  it("is available to both an editor and a read-only Area Coordinator", async () => {
    mocks.requireHonorsAccess.mockResolvedValue({ mode: "READ", viewer: { accountId: "acct-ac" } });
    const response = await CSV_GET(getRequest(), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    // Audited with the club, year, and row count only.
    expect(mocks.auditClubHonorsExport).toHaveBeenCalledWith("club-1", expect.any(String), rows.length, { accountId: "acct-ac" }, true);
  });
});

describe("single-member honor history and edit", () => {
  it("GET returns one member's full history", async () => {
    mocks.requireHonorsAccess.mockResolvedValue({ mode: "EDIT", actor: { accountId: "acct-1" } });
    mocks.listMemberHonorHistory.mockResolvedValue({ firstName: "Ada", lastName: "Lin", current: [], history: [] });
    const response = await MEMBER_GET(getRequest(), memberCtx());
    expect(await response.json()).toMatchObject({ firstName: "Ada" });
  });

  it("POST records one entry for one member (the single-member edit)", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    mocks.listMemberHonorHistory.mockResolvedValue({ firstName: "Ada", lastName: "Lin", current: [], history: [] });
    const response = await MEMBER_POST(postRequest({ honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "" }), memberCtx());
    expect(response.status).toBe(201);
    expect(mocks.recordMemberHonorEntries).toHaveBeenCalledWith("club-1", ["member-1"], expect.objectContaining({ honorId: "honor-1" }), { accountId: "acct-1" });
  });

  it("POST records a completed honor for one member with no completion date (#790)", async () => {
    mocks.requireHonorsEditAccess.mockResolvedValue({ accountId: "acct-1" });
    mocks.listMemberHonorHistory.mockResolvedValue({ firstName: "Ada", lastName: "Lin", current: [], history: [] });
    const response = await MEMBER_POST(postRequest({ honorId: "honor-1", status: "COMPLETED" }), memberCtx());
    expect(response.status).toBe(201);
    expect(mocks.recordMemberHonorEntries).toHaveBeenCalledWith("club-1", ["member-1"], expect.objectContaining({ status: "COMPLETED", completionDate: "" }), { accountId: "acct-1" });
  });

  it("an Area Coordinator viewer is rejected on POST and nothing is recorded", async () => {
    mocks.requireHonorsAccess.mockResolvedValue({ mode: "READ", viewer: { accountId: "acct-ac" } });
    mocks.requireHonorsEditAccess.mockRejectedValue(new RosterAccessError("NOT_FOUND", 404, "That club could not be found."));
    const response = await MEMBER_POST(postRequest({ honorId: "honor-1", status: "COMPLETED", completionDate: "2026-09-01" }), memberCtx());
    expect(response.status).toBe(404);
    expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();
  });

  it("a read-only viewer can't record an entry through this route", async () => {
    mocks.requireHonorsEditAccess.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    const response = await MEMBER_POST(postRequest({ honorId: "honor-1", status: "IN_PROGRESS" }), memberCtx());
    expect(response.status).toBe(403);
    expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();
  });
});
