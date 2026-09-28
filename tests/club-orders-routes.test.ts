import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The club order routes behind the real roster gate (#487, same as #531's
 * club supplies): neither `modules/club-orders/access` (there is none — it
 * reuses `modules/club-supplies/access`) nor `modules/club-rosters/access` is
 * mocked. Only the lookups underneath and the order storage are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  findAreaGrant: vi.fn(),
  findOrganization: vi.fn(),
  loadOrderWorkspace: vi.fn(),
  createOrderBatch: vi.fn(),
  markOrderBatchReceived: vi.fn(),
  markNeedsAwarded: vi.fn(),
  markNeedsAlreadyAwarded: vi.fn(),
  listOrderList: vi.fn(),
  listPickList: vi.fn(),
  syncHonorOrderNeeds: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
    areaCoordinatorGrant: { findUnique: mocks.findAreaGrant },
    organization: { findUnique: mocks.findOrganization },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/honors/order-source", () => ({ syncHonorOrderNeeds: mocks.syncHonorOrderNeeds }));
vi.mock("@/modules/club-orders/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-orders/repository")>("@/modules/club-orders/repository");
  return {
    ...actual,
    loadOrderWorkspace: mocks.loadOrderWorkspace,
    createOrderBatch: mocks.createOrderBatch,
    markOrderBatchReceived: mocks.markOrderBatchReceived,
    markNeedsAwarded: mocks.markNeedsAwarded,
    markNeedsAlreadyAwarded: mocks.markNeedsAlreadyAwarded,
    listOrderList: mocks.listOrderList,
    listPickList: mocks.listPickList,
  };
});

import { GET, POST } from "@/app/api/attendee/clubs/[organizationId]/orders/route";
import { POST as POST_RECEIVE } from "@/app/api/attendee/clubs/[organizationId]/orders/[batchId]/receive/route";
import { POST as POST_AWARD } from "@/app/api/attendee/clubs/[organizationId]/orders/award/route";
import { POST as POST_ALREADY } from "@/app/api/attendee/clubs/[organizationId]/orders/already-awarded/route";
import { GET as GET_CSV } from "@/app/api/attendee/clubs/[organizationId]/orders/csv/route";
import { buildOrderLines, readableOrderCsv } from "@/modules/club-orders/domain";
import { ClubOrderError } from "@/modules/club-orders/repository";

const clubFor = (organizationId: string, role: string) => ({ organizationId, name: "Test Pathfinders", role, sponsoringChurch: null });
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const ctx = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });
const batchCtx = (organizationId = "club-1", batchId = "batch-1") => ({ params: Promise.resolve({ organizationId, batchId }) });
const getRequest = () => new Request("https://events.imsda.test/api/attendee/x");
const postRequest = (body: unknown) => new Request("https://events.imsda.test/api/attendee/x", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "DIRECTOR")]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.findAreaGrant.mockResolvedValue(null);
  mocks.findOrganization.mockResolvedValue({ type: "CLUB", isActive: true });
  mocks.syncHonorOrderNeeds.mockResolvedValue({ count: 0 });
  mocks.loadOrderWorkspace.mockResolvedValue({ lines: [], unmatched: [], batches: [], awardable: [] });
  mocks.createOrderBatch.mockResolvedValue({ batchId: "batch-1", createdAt: "2026-09-28T00:00:00.000Z", lines: [] });
  mocks.markOrderBatchReceived.mockResolvedValue({ id: "batch-1", status: "RECEIVED", createdAt: "x", receivedAt: "y", lines: [] });
  mocks.markNeedsAwarded.mockResolvedValue({ awarded: 1, fromStock: 0 });
  mocks.markNeedsAlreadyAwarded.mockResolvedValue({ marked: 2 });
  mocks.listOrderList.mockResolvedValue({ lines: [], unmatched: [] });
  mocks.listPickList.mockResolvedValue([]);
});

describe("club order routes (#487): permissioned like club supplies (#531)", () => {
  it.each(["DIRECTOR", "DEPUTY"])("a %s can view the order list and place an order", async (role) => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", role)]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: true });
    expect(mocks.syncHonorOrderNeeds).toHaveBeenCalledWith("club-1");
    const write = await POST(postRequest({ extras: { "item-1": 2 } }), ctx());
    expect(write.status).toBe(200);
    expect(mocks.createOrderBatch).toHaveBeenCalledWith("club-1", { "item-1": 2 }, { accountId: "director-1" });
  });

  it("a registrar views read-only and is refused placing an order", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "REGISTRAR")]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    // A view-only visit reads what's on file and never writes.
    expect(mocks.syncHonorOrderNeeds).not.toHaveBeenCalled();
    const write = await POST(postRequest({ extras: {} }), ctx());
    expect(write.status).toBe(403);
    expect(mocks.createOrderBatch).not.toHaveBeenCalled();
    expect((await GET_CSV(new Request("https://events.imsda.test/x?view=readable"), ctx())).status).toBe(200);
    expect(mocks.syncHonorOrderNeeds).not.toHaveBeenCalled();
    expect((await POST_ALREADY(postRequest({ needIds: ["need-1"] }), ctx())).status).toBe(403);
    expect(mocks.markNeedsAlreadyAwarded).not.toHaveBeenCalled();
  });

  it("another club's director gets 404, and nothing runs", async () => {
    const write = await POST(postRequest({ extras: {} }), ctx("club-2"));
    expect(write.status).toBe(404);
    expect(mocks.createOrderBatch).not.toHaveBeenCalled();
    expect(mocks.syncHonorOrderNeeds).not.toHaveBeenCalled();
  });

  it("an Area Coordinator views read-only and can't receive or award", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    mocks.findAreaGrant.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    expect(mocks.syncHonorOrderNeeds).not.toHaveBeenCalled();
    expect((await POST_RECEIVE(postRequest({}), batchCtx())).status).toBe(404);
    expect((await POST_AWARD(postRequest({ needIds: ["need-1"] }), ctx())).status).toBe(404);
    expect(mocks.markOrderBatchReceived).not.toHaveBeenCalled();
    expect(mocks.markNeedsAwarded).not.toHaveBeenCalled();
  });

  it("receives an order and awards needs for a director", async () => {
    const receive = await POST_RECEIVE(postRequest({}), batchCtx());
    expect(receive.status).toBe(200);
    expect(mocks.markOrderBatchReceived).toHaveBeenCalledWith("club-1", "batch-1", { accountId: "director-1" });
    const award = await POST_AWARD(postRequest({ needIds: ["need-1", "need-2"] }), ctx());
    expect(award.status).toBe(200);
    expect(mocks.markNeedsAwarded).toHaveBeenCalledWith("club-1", ["need-1", "need-2"], { accountId: "director-1" });
  });

  it("maps NOTHING_TO_ORDER to 409 and BATCH_NOT_FOUND to 404", async () => {
    mocks.createOrderBatch.mockRejectedValue(new ClubOrderError("NOTHING_TO_ORDER", "Nothing to order."));
    expect((await POST(postRequest({ extras: {} }), ctx())).status).toBe(409);
    mocks.markOrderBatchReceived.mockRejectedValue(new ClubOrderError("BATCH_NOT_FOUND", "Not found."));
    expect((await POST_RECEIVE(postRequest({}), batchCtx())).status).toBe(404);
  });

  it("marks needs already handed out for a director, and maps ALREADY_RECEIVED / NOT_ENOUGH_STOCK to 409", async () => {
    const response = await POST_ALREADY(postRequest({ needIds: ["need-1", "need-2"] }), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marked: 2 });
    expect(mocks.markNeedsAlreadyAwarded).toHaveBeenCalledWith("club-1", ["need-1", "need-2"], { accountId: "director-1" });
    mocks.markOrderBatchReceived.mockRejectedValue(new ClubOrderError("ALREADY_RECEIVED", "Already received."));
    expect((await POST_RECEIVE(postRequest({}), batchCtx())).status).toBe(409);
    mocks.markNeedsAwarded.mockRejectedValue(new ClubOrderError("NOT_ENOUGH_STOCK", "Not enough."));
    expect((await POST_AWARD(postRequest({ needIds: ["need-1"] }), ctx())).status).toBe(409);
  });

  it("the top-level order list CSV equals the screen's lines with the typed extras applied", async () => {
    const item = { itemId: "item-1", name: "Knot Tying", catalogNumber: "002120" };
    // The repository applies the extras it's given; this stub does the same with the real math.
    mocks.listOrderList.mockImplementation(async (_organizationId: string, extras: Map<string, number>) => ({
      lines: buildOrderLines([item], new Map([["item-1", 5]]), new Map([["item-1", 2]]), extras),
      unmatched: [],
    }));
    const response = await GET_CSV(new Request("https://events.imsda.test/x?view=readable&extra=item-1:3"), ctx());
    expect(response.status).toBe(200);
    expect(mocks.listOrderList).toHaveBeenCalledWith("club-1", new Map([["item-1", 3]]));
    const screen = buildOrderLines([item], new Map([["item-1", 5]]), new Map([["item-1", 2]]), new Map([["item-1", 3]]));
    expect(await response.text()).toBe(readableOrderCsv(screen));
    // An editor's download syncs first.
    expect(mocks.syncHonorOrderNeeds).toHaveBeenCalledWith("club-1");
  });

  it("refuses malformed extras on an export with 400", async () => {
    const response = await GET_CSV(new Request("https://events.imsda.test/x?view=adventsource&extra=item-1:-2"), ctx());
    expect(response.status).toBe(400);
    expect(mocks.listOrderList).not.toHaveBeenCalled();
  });

  it("rejects an empty award list", async () => {
    const response = await POST_AWARD(postRequest({ needIds: [] }), ctx());
    expect(response.status).toBe(400);
    expect(mocks.markNeedsAwarded).not.toHaveBeenCalled();
  });
});
