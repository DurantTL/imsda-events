import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  itemFindMany: vi.fn(),
  itemFindUnique: vi.fn(),
  itemCreateMany: vi.fn(),
  itemUpdate: vi.fn(),
  honorFindMany: vi.fn(),
  honorUpdate: vi.fn(),
  stockFindMany: vi.fn(),
  stockUpsert: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const client = {
    clubSupplyItem: {
      findMany: mocks.itemFindMany,
      findUnique: mocks.itemFindUnique,
      createMany: mocks.itemCreateMany,
      update: mocks.itemUpdate,
    },
    honor: { findMany: mocks.honorFindMany, update: mocks.honorUpdate },
    clubSupplyStock: { findMany: mocks.stockFindMany, upsert: mocks.stockUpsert },
    $transaction: (work: (tx: unknown) => unknown) => work(client),
  };
  return { getPrisma: () => client };
});

import { parseClubSupplyCsv } from "@/modules/club-supplies/catalog-csv";
import {
  applyClubSupplyImport,
  ClubSupplyError,
  previewClubSupplyImport,
  setClubStockQuantity,
  setClubSupplyItemActive,
} from "@/modules/club-supplies/repository";

const csv = [
  "section,item,adventsource_catalog_number",
  "Nature,Bogs & Fens,005157",
  "Nature,Unicorns,009999",
  "Miscellaneous,Good Conduct Star (1st),002305",
  "Miscellaneous,Good Conduct Star (2nd),002305",
].join("\n");
const honors = [{ id: "h-1", code: "SYN-001", name: "Bogs and Fens", catalogNumber: null, category: null, updatedAt: new Date(0) }];

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.itemFindMany.mockResolvedValue([]);
  mocks.honorFindMany.mockResolvedValue(honors);
  mocks.stockFindMany.mockResolvedValue([]);
});

describe("club supply catalog import (#531)", () => {
  it("saves exactly the previewed plan when the fingerprint matches, audited with counts only", async () => {
    const rows = parseClubSupplyCsv(csv);
    const preview = await previewClubSupplyImport(rows);
    expect(preview.plan.summary).toMatchObject({ added: 4, honorsMatched: 1, honorsUnmatched: 1, repeatedNumbers: 1 });

    const result = await applyClubSupplyImport(rows, preview.fingerprint, "admin-1");
    expect(result.summary.added).toBe(4);
    expect(mocks.itemCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ section: "NATURE", name: "Bogs & Fens", catalogNumber: "005157", honorId: "h-1" }),
        expect.objectContaining({ section: "NATURE", name: "Unicorns", honorId: null }),
      ]),
    });
    expect(mocks.honorUpdate).toHaveBeenCalledWith({ where: { id: "h-1" }, data: { catalogNumber: "005157", category: "NATURE" } });
    const [audit] = mocks.writeAuditLog.mock.calls[0];
    expect(audit).toMatchObject({
      actorUserId: "admin-1",
      action: "CLUB_SUPPLY_CATALOG_IMPORTED",
      metadata: { rows: 4, added: 4, updated: 0, skipped: 0, honorsMatched: 1, honorsUnmatched: 1, honorsUpdated: 1, repeatedNumbers: 1 },
    });
    expect(JSON.stringify(audit)).not.toMatch(/Bogs|Unicorn|Good Conduct/);
  });

  it("refuses with PREVIEW_CHANGED, saving nothing, when the catalog changed since the preview", async () => {
    const rows = parseClubSupplyCsv(csv);
    const preview = await previewClubSupplyImport(rows);
    mocks.honorFindMany.mockResolvedValue([{ ...honors[0], updatedAt: new Date(1) }]);
    await expect(applyClubSupplyImport(rows, preview.fingerprint, "admin-1")).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    await expect(applyClubSupplyImport(rows, "not-the-fingerprint", "admin-1")).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    expect(mocks.itemCreateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("maps a unique-constraint race (P2002) to CATALOG_CONFLICT", async () => {
    const rows = parseClubSupplyCsv(csv);
    const preview = await previewClubSupplyImport(rows);
    mocks.itemCreateMany.mockRejectedValue(p2002());
    const error = await applyClubSupplyImport(rows, preview.fingerprint, "admin-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClubSupplyError);
    expect(error).toMatchObject({ code: "CATALOG_CONFLICT" });
  });

  it("toggles an item's active flag with an audit entry, and 404s a missing item", async () => {
    mocks.itemFindUnique.mockResolvedValue({ id: "i-1", isActive: true });
    await setClubSupplyItemActive("i-1", false, "admin-1");
    expect(mocks.itemUpdate).toHaveBeenCalledWith({ where: { id: "i-1" }, data: { isActive: false } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_SUPPLY_ITEM_DEACTIVATED", entityId: "i-1", metadata: { isActive: false },
    }), expect.anything());

    mocks.itemFindUnique.mockResolvedValue(null);
    await expect(setClubSupplyItemActive("missing", true, "admin-1")).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
  });
});

describe("club stock (#531)", () => {
  it("upserts the club and item pair and audits quantities against the stock row's own id", async () => {
    mocks.itemFindUnique.mockResolvedValue({ isActive: true, stock: [{ quantityOnHand: 2 }] });
    mocks.stockUpsert.mockResolvedValue({ id: "stock-7", itemId: "i-1", quantityOnHand: 5 });
    await expect(setClubStockQuantity("club-1", "i-1", 5, { accountId: "acct-1" })).resolves.toEqual({ id: "stock-7", itemId: "i-1", quantityOnHand: 5 });
    expect(mocks.stockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId_itemId: { organizationId: "club-1", itemId: "i-1" } },
      create: expect.objectContaining({ organizationId: "club-1", itemId: "i-1", quantityOnHand: 5, updatedByAccountId: "acct-1" }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith({
      action: "CLUB_SUPPLY_STOCK_UPDATED",
      entityType: "ClubSupplyStock",
      entityId: "stock-7",
      summary: "Set a club supply stock quantity from 2 to 5.",
      metadata: { organizationId: "club-1", itemId: "i-1", previousQuantity: 2, quantityOnHand: 5, actorAttendeeAccountId: "acct-1" },
    }, expect.anything());
  });

  it("attributes a staff act-as director to the staff user", async () => {
    mocks.itemFindUnique.mockResolvedValue({ isActive: true, stock: [] });
    mocks.stockUpsert.mockResolvedValue({ id: "stock-8", itemId: "i-1", quantityOnHand: 1 });
    await setClubStockQuantity("club-1", "i-1", 1, { userId: "user-1", actAsId: "act-1" });
    expect(mocks.stockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ updatedByUserId: "user-1", updatedByAccountId: null }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "user-1", metadata: expect.objectContaining({ actAsId: "act-1", previousQuantity: 0 }),
    }), expect.anything());
  });

  it("refuses an unknown item, or an inactive one the club holds none of (no row, or a row at 0)", async () => {
    mocks.itemFindUnique.mockResolvedValue(null);
    await expect(setClubStockQuantity("club-1", "nope", 1, { accountId: "acct-1" })).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
    mocks.itemFindUnique.mockResolvedValue({ isActive: false, stock: [] });
    await expect(setClubStockQuantity("club-1", "old", 1, { accountId: "acct-1" })).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
    mocks.itemFindUnique.mockResolvedValue({ isActive: false, stock: [{ quantityOnHand: 0 }] });
    await expect(setClubStockQuantity("club-1", "old", 1, { accountId: "acct-1" })).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
    expect(mocks.stockUpsert).not.toHaveBeenCalled();
  });

  it("still lets a club record an inactive item it holds some of", async () => {
    mocks.itemFindUnique.mockResolvedValue({ isActive: false, stock: [{ quantityOnHand: 2 }] });
    mocks.stockUpsert.mockResolvedValue({ id: "stock-9", itemId: "old", quantityOnHand: 0 });
    await expect(setClubStockQuantity("club-1", "old", 0, { accountId: "acct-1" })).resolves.toMatchObject({ quantityOnHand: 0 });
  });

  it("maps two racing first saves (P2002) to CATALOG_CONFLICT", async () => {
    mocks.itemFindUnique.mockResolvedValue({ isActive: true, stock: [] });
    mocks.stockUpsert.mockRejectedValue(p2002());
    await expect(setClubStockQuantity("club-1", "i-1", 1, { accountId: "acct-1" })).rejects.toMatchObject({ code: "CATALOG_CONFLICT" });
  });
});
