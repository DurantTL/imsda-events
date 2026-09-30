import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  itemFindUnique: vi.fn(),
  itemFindMany: vi.fn(),
  needFindMany: vi.fn(),
  needGroupBy: vi.fn(),
  stockFindMany: vi.fn(),
  lineFindMany: vi.fn(),
  lineUpsert: vi.fn(),
  lineDeleteMany: vi.fn(),
  orgFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const client = {
    clubSupplyItem: { findUnique: mocks.itemFindUnique, findMany: mocks.itemFindMany },
    clubOrderNeed: { findMany: mocks.needFindMany, groupBy: mocks.needGroupBy },
    clubSupplyStock: { findMany: mocks.stockFindMany },
    clubOrderListLine: { findMany: mocks.lineFindMany, upsert: mocks.lineUpsert, deleteMany: mocks.lineDeleteMany },
    organization: { findUnique: mocks.orgFindUnique },
    $executeRaw: mocks.executeRaw,
    $transaction: (work: (tx: unknown) => unknown) => work(client),
  };
  return { getPrisma: () => client };
});

import { listHelperLines, loadOrderExportHeader, ClubOrderError, setOrderListQuantity } from "@/modules/club-orders/repository";

const actor = { accountId: "director-1" };
const knots = { id: "knots", name: "Knot Tying", catalogNumber: "002120", section: "OUTDOOR_INDUSTRIES", sizeLabel: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.itemFindUnique.mockResolvedValue({ isActive: true });
  mocks.needFindMany.mockResolvedValue([]);
  mocks.needGroupBy.mockResolvedValue([]);
  mocks.stockFindMany.mockResolvedValue([]);
  mocks.lineFindMany.mockResolvedValue([]);
  mocks.itemFindMany.mockResolvedValue([]);
});

describe("setOrderListQuantity (#654)", () => {
  it("saves a quantity under the club's lock and audits the numbers only", async () => {
    await expect(setOrderListQuantity("club-1", "knots", 4, actor)).resolves.toEqual({ itemId: "knots", quantity: 4 });
    expect(mocks.executeRaw).toHaveBeenCalled();
    expect(mocks.lineUpsert).toHaveBeenCalledWith({
      where: { organizationId_itemId: { organizationId: "club-1", itemId: "knots" } },
      create: { organizationId: "club-1", itemId: "knots", quantity: 4 },
      update: { quantity: 4 },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_ORDER_LIST_LINE_SET", metadata: expect.objectContaining({ organizationId: "club-1", itemId: "knots", quantity: 4 }) }),
      expect.anything(),
    );
  });

  it("null puts the line back by deleting the edit", async () => {
    await setOrderListQuantity("club-1", "knots", null, actor);
    expect(mocks.lineDeleteMany).toHaveBeenCalledWith({ where: { organizationId: "club-1", itemId: "knots" } });
    expect(mocks.lineUpsert).not.toHaveBeenCalled();
  });

  it("refuses an unknown item, and an inactive one unless resetting", async () => {
    mocks.itemFindUnique.mockResolvedValue(null);
    await expect(setOrderListQuantity("club-1", "nope", 1, actor)).rejects.toBeInstanceOf(ClubOrderError);
    mocks.itemFindUnique.mockResolvedValue({ isActive: false });
    await expect(setOrderListQuantity("club-1", "old", 1, actor)).rejects.toBeInstanceOf(ClubOrderError);
    await expect(setOrderListQuantity("club-1", "old", null, actor)).resolves.toEqual({ itemId: "old", quantity: null });
    expect(mocks.lineUpsert).not.toHaveBeenCalled();
  });
});

describe("listHelperLines (#654)", () => {
  const need = (id: string) => ({
    id, sourceType: "HONOR", sourceId: id, personId: `p-${id}`, itemId: "knots", sourceLabel: "", sourceDate: "2026-09-01", createdAt: new Date(0), item: knots,
  });

  it("counts needs per item and subtracts the club's stock, so a saved inventory edit lowers to order", async () => {
    mocks.needFindMany.mockResolvedValue([need("a"), need("b"), need("c")]);
    const before = await listHelperLines("club-1");
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ itemId: "knots", section: "HONORS", needed: 3, onHand: 0, toOrder: 3 });

    mocks.stockFindMany.mockResolvedValue([{ itemId: "knots", quantityOnHand: 2 }]);
    const after = await listHelperLines("club-1");
    expect(after[0]).toMatchObject({ needed: 3, onHand: 2, toOrder: 1 });
  });

  it("applies a saved edit, and adds an item nothing calls for", async () => {
    mocks.needFindMany.mockResolvedValue([need("a")]);
    mocks.lineFindMany.mockResolvedValue([{ itemId: "knots", quantity: 6 }, { itemId: "star", quantity: 2 }]);
    mocks.itemFindMany.mockResolvedValue([{ id: "star", section: "MISCELLANEOUS", name: "Good Conduct Star", catalogNumber: "000123", sizeLabel: null }]);
    const lines = await listHelperLines("club-1");
    expect(lines.map((line) => [line.itemId, line.section, line.computedNeeded, line.needed, line.edited])).toEqual([
      ["knots", "HONORS", 1, 6, true],
      ["star", "OTHER", 0, 2, true],
    ]);
  });
});

describe("loadOrderExportHeader (#654)", () => {
  it("uses the club, its church and the director's contact, with the club profile as a fallback", async () => {
    mocks.orgFindUnique.mockResolvedValue({
      name: "Test Pathfinders",
      parentOrganization: { name: "Sample Church" },
      clubProfile: { contactEmail: "club@example.test", contactPhone: "555-0199" },
      directorGrants: [{ attendeeAccount: { displayName: "Test Director", email: "director@example.test", phone: null } }],
    });
    const header = await loadOrderExportHeader("club-1", new Date("2026-09-30T18:00:00Z"));
    expect(header).toEqual({
      clubName: "Test Pathfinders",
      church: "Sample Church",
      directorName: "Test Director",
      directorEmail: "director@example.test",
      directorPhone: "555-0199",
      date: "2026-09-30",
    });
  });

  it("is blank, not an error, for a club with no director or church on file", async () => {
    mocks.orgFindUnique.mockResolvedValue({ name: "Test Pathfinders", parentOrganization: null, clubProfile: null, directorGrants: [] });
    expect(await loadOrderExportHeader("club-1", new Date("2026-09-30T18:00:00Z"))).toMatchObject({ church: "", directorName: "", directorEmail: "", directorPhone: "" });
  });
});
