import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSystemAdministrator: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  listHonors: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const client = {
    honor: {
      createMany: mocks.createMany,
      update: mocks.update,
      findMany: async () => (await mocks.listHonors()).map((honor: Record<string, unknown>) => ({ ...honor, updatedAt: new Date(), _count: { offerings: 0 } })),
    },
    $transaction: (work: (tx: unknown) => unknown) => work(client),
  };
  return { getPrisma: () => client };
});

import { POST } from "@/app/api/admin/honors/import/route";
import { honorCsvTemplate, parseHonorCsv, planHonorImport } from "@/modules/honors/catalog-csv";

const existing = [
  { id: "h-1", code: "AC-001", name: "Knot Tying", description: "", isActive: true, catalogNumber: null, category: null },
  { id: "h-2", code: "HM-010", name: "Camping Skills I", description: "Basic camping", isActive: true, catalogNumber: null, category: null },
];
const csv = [
  "Code,Name,Description,Active",
  "ac-001,Knot Tying,,",
  "HM-010,Camping Skills I,Updated text,",
  "NA-020,Birds,,yes",
  ",No Code,,",
  "NA-020,Birds again,,",
  "OD-001,Orienteering,,maybe",
].join("\n");

const request = (body: unknown) => new Request("https://events.imsda.test/api/admin/honors/import", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.listHonors.mockResolvedValue(existing);
});

describe("honor catalog CSV (#385)", () => {
  it("offers a template with the catalog's columns", () => {
    expect(honorCsvTemplate().trim()).toBe('"Code","Name","Description","Active","Catalog Number","Category"');
  });

  it("accepts optional Catalog Number and Category columns (#531), keeping leading zeros", () => {
    const rows = parseHonorCsv([
      "Code,Name,Catalog Number,Category",
      "AC-001,Knot Tying,005850,Outdoor Industries",
      "HM-010,Camping Skills I,,",
      "NA-020,Birds,005180,Reacreation",
      "NA-021,Bats,005170,Underwater Basket Weaving",
      "NA-022,Bears,00 51?,Nature",
    ].join("\n"));
    expect(rows[4].catalogNumber).toBeUndefined();
    expect(rows[4].problems[0]).toMatch(/letters, digits, or dashes/);
    expect(rows[0]).toMatchObject({ catalogNumber: "005850", category: "OUTDOOR_INDUSTRIES", problems: [] });
    expect(rows[1].catalogNumber).toBeUndefined();
    expect(rows[1].category).toBeUndefined();
    expect(rows[2]).toMatchObject({ category: "RECREATION", problems: [] });
    expect(rows[3].problems[0]).toMatch(/isn't one of the honor catalog's categories/);

    const plan = planHonorImport(rows, existing);
    expect(plan.map((step) => step.action)).toEqual(["UPDATE", "SKIP", "ADD", "SKIP", "SKIP"]);
  });

  it("saves the catalog number and category on add and update", async () => {
    const withCatalog = "Code,Name,Catalog Number,Category\nAC-001,Knot Tying,005850,Outdoor Industries\nNA-020,Birds,005180,Nature";
    expect((await POST(request({ csv: withCatalog, confirm: true }))).status).toBe(200);
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ code: "NA-020", catalogNumber: "005180", category: "NATURE" })],
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "h-1" },
      data: expect.objectContaining({ catalogNumber: "005850", category: "OUTDOOR_INDUSTRIES" }),
    });
  });

  it("matches by code, updates only what changed, and never guesses", () => {
    const plan = planHonorImport(parseHonorCsv(csv), existing);
    expect(plan.map((step) => [step.row.code, step.action])).toEqual([
      ["AC-001", "SKIP"],
      ["HM-010", "UPDATE"],
      ["NA-020", "ADD"],
      ["", "SKIP"],
      ["NA-020", "SKIP"],
      ["OD-001", "SKIP"],
    ]);
    expect(plan[0].message).toMatch(/nothing to change/);
    expect(plan[4].message).toMatch(/earlier in the file/);
    expect(plan[5].message).toMatch(/Yes or No/);
  });

  it("previews without saving, then saves in one transaction, audited with counts", async () => {
    const preview = await POST(request({ csv }));
    expect(preview.status).toBe(200);
    expect(mocks.createMany).not.toHaveBeenCalled();

    const saved = await POST(request({ csv, confirm: true }));
    expect(saved.status).toBe(200);
    expect(mocks.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ code: "NA-020", name: "Birds", isActive: true })] });
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "h-2" }, data: expect.objectContaining({ description: "Updated text" }) });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "HONOR_CATALOG_IMPORTED", metadata: { rows: 6, added: 1, updated: 1, skipped: 4 },
    }), expect.anything());
  });

  it("is for system administrators only", async () => {
    const { AccessDeniedError } = await import("@/modules/access/authorization");
    mocks.requireSystemAdministrator.mockRejectedValueOnce(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await POST(request({ csv }))).status).toBe(403);
  });
});
