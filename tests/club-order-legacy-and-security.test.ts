import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Orders helper list (#654) follow-ups: a legacy ORDERED batch can still be
 * received, the line-edit route refuses cross-origin writes, and the print
 * page shows nothing when the roster gate is closed. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  batchUpdateMany: vi.fn(),
  batchFindFirst: vi.fn(),
  batchFindUniqueOrThrow: vi.fn(),
  needUpdateMany: vi.fn(),
  stockUpsert: vi.fn(),
  executeRaw: vi.fn(),
  writeAuditLog: vi.fn(),
  setOrderListQuantity: vi.fn(),
  getRosterAccessStateForPage: vi.fn(),
  listHelperLines: vi.fn(),
  loadOrderExportHeader: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const client = {
    clubSupplyOrderBatch: { updateMany: mocks.batchUpdateMany, findFirst: mocks.batchFindFirst, findUniqueOrThrow: mocks.batchFindUniqueOrThrow },
    clubOrderNeed: { updateMany: mocks.needUpdateMany },
    clubSupplyStock: { upsert: mocks.stockUpsert },
    $executeRaw: mocks.executeRaw,
    $transaction: (work: (tx: unknown) => unknown) => work(client),
  };
  return { getPrisma: () => client };
});
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, getRosterAccessStateForPage: mocks.getRosterAccessStateForPage };
});
vi.mock("@/modules/club-orders/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-orders/repository")>("@/modules/club-orders/repository");
  return { ...actual, setOrderListQuantity: mocks.setOrderListQuantity, listHelperLines: mocks.listHelperLines, loadOrderExportHeader: mocks.loadOrderExportHeader };
});
vi.mock("@/modules/club-supplies/access", () => ({ requireClubSupplyEditAccess: vi.fn(async () => ({ accountId: "director-1" })) }));

import { PUT } from "@/app/api/attendee/clubs/[organizationId]/orders/lines/[itemId]/route";
import ClubOrderListPrintPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/orders/print/page";
import { markOrderBatchReceived } from "@/modules/club-orders/repository";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("receiving a legacy ORDERED batch (#654)", () => {
  it("flips the batch, adds the ordered quantity to stock, and moves its needs to RECEIVED as before", async () => {
    mocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    mocks.batchFindUniqueOrThrow.mockResolvedValue({
      id: "batch-1",
      createdAt: new Date("2026-08-20T15:00:00Z"),
      lines: [{
        itemId: "knots", neededCount: 2, extraCount: 1, stockAtOrderTime: 0, quantityOrdered: 3,
        item: { id: "knots", name: "Knot Tying", catalogNumber: "002120" },
      }],
    });
    mocks.needUpdateMany.mockResolvedValue({ count: 2 });
    const result = await markOrderBatchReceived("club-1", "batch-1", { accountId: "director-1" });
    expect(mocks.batchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "batch-1", organizationId: "club-1", status: "ORDERED" },
      data: expect.objectContaining({ status: "RECEIVED" }),
    }));
    expect(mocks.stockUpsert).toHaveBeenCalledWith({
      where: { organizationId_itemId: { organizationId: "club-1", itemId: "knots" } },
      create: { organizationId: "club-1", itemId: "knots", quantityOnHand: 3 },
      update: { quantityOnHand: { increment: 3 } },
    });
    expect(mocks.needUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: "club-1", batchId: "batch-1", status: "ORDERED" },
      data: { status: "RECEIVED" },
    });
    expect(result.status).toBe("RECEIVED");
  });
});

describe("PUT orders/lines/[itemId] (#654)", () => {
  it("rejects a cross-origin write before anything runs", async () => {
    const response = await PUT(
      new Request("https://events.imsda.test/api/attendee/clubs/club-1/orders/lines/item-1", {
        method: "PUT",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ quantity: 1 }),
      }),
      { params: Promise.resolve({ organizationId: "club-1", itemId: "item-1" }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST_ORIGIN" });
    expect(mocks.setOrderListQuantity).not.toHaveBeenCalled();
  });

  it("rejects a write with no Origin header", async () => {
    const response = await PUT(
      new Request("https://events.imsda.test/api/attendee/clubs/club-1/orders/lines/item-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity: 1 }),
      }),
      { params: Promise.resolve({ organizationId: "club-1", itemId: "item-1" }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.setOrderListQuantity).not.toHaveBeenCalled();
  });
});

describe("the printable order list (#654)", () => {
  it("renders nothing and loads no data when the roster gate is closed", async () => {
    for (const state of ["LOCKED", "NO_ROSTER", "NONE"]) {
      mocks.getRosterAccessStateForPage.mockResolvedValue({ state });
      const page = await ClubOrderListPrintPage({ params: Promise.resolve({ organizationId: "club-1" }) });
      expect(page).toBeNull();
    }
    expect(mocks.listHelperLines).not.toHaveBeenCalled();
    expect(mocks.loadOrderExportHeader).not.toHaveBeenCalled();
  });
});
