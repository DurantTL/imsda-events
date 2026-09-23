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
  { id: "h-1", code: "AC-001", name: "Knot Tying", description: "", isActive: true },
  { id: "h-2", code: "HM-010", name: "Camping Skills I", description: "Basic camping", isActive: true },
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
    expect(honorCsvTemplate().trim()).toBe('"Code","Name","Description","Active"');
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
