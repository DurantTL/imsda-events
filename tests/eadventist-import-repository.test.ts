import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for the organization table and audit log. */
type Row = Record<string, unknown> & { id: string; type: string; name: string; isActive: boolean; eadventistId: string | null; affiliatedOrganizationId: string | null; parentOrganizationId?: string | null };
const state = vi.hoisted(() => ({ rows: [] as unknown[], audit: [] as unknown[], next: 1 }));
const rows = () => state.rows as Row[];

const db = vi.hoisted(() => {
  const organization = {
    findMany: async () => rows().map((row) => ({
      ...row,
      disbandedOn: (row.disbandedOn as Date | null) ?? null,
      affiliatedOrganization: rows().find((other) => other.id === row.affiliatedOrganizationId) ? { eadventistId: rows().find((other) => other.id === row.affiliatedOrganizationId)!.eadventistId } : null,
    })).filter((row) => row.eadventistId || row.type === "CHURCH"),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (data.eadventistId && rows().some((row) => row.eadventistId === data.eadventistId)) throw Object.assign(new Error("dupe"), { code: "P2002" });
      const row = { affiliatedOrganizationId: null, disbandedOn: null, ...data, id: `org-${state.next++}` } as unknown as Row;
      rows().push(row);
      return { id: row.id };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(rows().find((row) => row.id === where.id)!, data);
      return {};
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows().find((row) => row.id === where.id)!,
    findUnique: async ({ where }: { where: { id: string } }) => rows().find((row) => row.id === where.id) ?? null,
    findFirst: async ({ where }: { where: { parentOrganizationId: string; type: string; isActive: boolean } }) =>
      rows().find((row) => row.parentOrganizationId === where.parentOrganizationId && row.type === where.type && row.isActive === where.isActive) ?? null,
    count: async ({ where }: { where: { parentOrganizationId: string } }) => rows().filter((row) => row.parentOrganizationId === where.parentOrganizationId).length,
  };
  const client = {
    organization,
    auditLog: { create: async ({ data }: { data: unknown }) => { state.audit.push(data); return data; } },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(client),
  };
  return client;
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => db }));

import { commitEadventistImport, previewEadventistImport, setDirectoryOrganizationActive } from "@/modules/organizations/eadventist-import-repository";
import { OrganizationOperationError } from "@/modules/organizations/repository";

const fixture = readFileSync(join(__dirname, "fixtures", "eadventist-organizations-synthetic.csv"), "utf8");
const byName = (name: string) => rows().find((row) => row.name === name)!;

beforeEach(() => {
  state.rows = [];
  state.audit = [];
  state.next = 1;
});

describe("eAdventist import storage (#649)", () => {
  it("previews without writing anything", async () => {
    const preview = await previewEadventistImport(fixture);
    expect(preview.counts).toMatchObject({ new: 12, flagged: 1 });
    expect(rows()).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });

  it("creates every record with its kind, resolves parents, and audits counts only", async () => {
    const result = await commitEadventistImport(fixture, "admin-1");
    expect(result).toMatchObject({ committed: true, counts: { new: 12, flagged: 1 } });
    expect(rows()).toHaveLength(12);
    expect(new Set(rows().map((row) => row.type))).toEqual(new Set(["CONFERENCE", "CHURCH", "COMPANY", "GROUP", "SCHOOL", "EARLY_CHILDHOOD", "BOOKSTORE", "COMMUNITY_CENTER", "CAMP", "ASSOCIATION"]));
    expect(byName("Sample Creek Company").affiliatedOrganizationId).toBe(byName("Sample Hills SDA Church").id);
    expect(byName("Sample Hills SDA Church").affiliatedOrganizationId).toBeNull();
    expect(byName("Sample Ridge Group")).toMatchObject({ isActive: true, disbandedOn: new Date("2024-03-01T00:00:00.000Z") });
    expect(byName("Sample Hills SDA Church")).toMatchObject({ normalizedName: "sample hills sda church", streetAddress: "10 Sample Road", eadventistId: "9002", sourceOrgType: "Church" });
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ actorUserId: "admin-1", action: "ORGANIZATIONS_EADVENTIST_IMPORTED", entityType: "OrganizationImport" });
    expect(JSON.stringify(state.audit)).not.toContain("Sample Hills");
  });

  it("is idempotent: a second upload adds nothing and changes nothing", async () => {
    await commitEadventistImport(fixture, "admin-1");
    const snapshot = JSON.stringify(rows());
    const again = await commitEadventistImport(fixture, "admin-1");
    expect(again.counts).toMatchObject({ new: 0, updated: 0, unchanged: 12 });
    expect(rows()).toHaveLength(12);
    expect(JSON.stringify(rows())).toBe(snapshot);
  });

  it("keeps a staff decision to deactivate a record across a re-upload", async () => {
    await commitEadventistImport(fixture, "admin-1");
    await setDirectoryOrganizationActive(byName("Sample Ridge Group").id, false, "admin-1");
    expect(byName("Sample Ridge Group").isActive).toBe(false);
    const changed = fixture.replace("Sample Junior Academy", "Sample Junior Academy East");
    const result = await commitEadventistImport(changed, "admin-1");
    expect(result.counts).toMatchObject({ new: 0, updated: 1 });
    expect(byName("Sample Ridge Group").isActive).toBe(false);
    expect(rows().some((row) => row.name === "Sample Junior Academy East")).toBe(true);
    expect(rows()).toHaveLength(12);
  });

  it("links an existing church by name once, keeping its id and active flag", async () => {
    rows().push({ id: "church-old", type: "CHURCH", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", isActive: false, eadventistId: null, affiliatedOrganizationId: null } as Row);
    const preview = await previewEadventistImport(fixture);
    expect(preview.items.find((item) => item.name === "Sample Hills SDA Church")).toMatchObject({ action: "UPDATED", matchedBy: "NAME" });
    await commitEadventistImport(fixture, "admin-1");
    expect(rows()).toHaveLength(12);
    expect(rows().find((row) => row.id === "church-old")).toMatchObject({ eadventistId: "9002", isActive: false, city: "Sample Hills" });
    const again = await previewEadventistImport(fixture);
    expect(again.counts).toMatchObject({ new: 0, updated: 0, unchanged: 12 });
  });

  it("keeps a church that sponsors clubs as a church even if the export retypes it", async () => {
    await commitEadventistImport(fixture, "admin-1");
    rows().push({ id: "club-1", type: "CLUB", name: "Sample Club", isActive: true, eadventistId: null, affiliatedOrganizationId: null, parentOrganizationId: byName("Sample Hills SDA Church").id } as Row);
    await commitEadventistImport(fixture.replace("Sample Hills SDA Church,Church,", "Sample Hills SDA Church,Company,"), "admin-1");
    expect(byName("Sample Hills SDA Church").type).toBe("CHURCH");
  });

  it("refuses to switch a church off while it has an active club, and never touches clubs", async () => {
    await commitEadventistImport(fixture, "admin-1");
    const church = byName("Sample Hills SDA Church");
    rows().push({ id: "club-1", type: "CLUB", name: "Sample Club", isActive: true, eadventistId: null, affiliatedOrganizationId: null, parentOrganizationId: church.id } as Row);
    await expect(setDirectoryOrganizationActive(church.id, false, "admin-1")).rejects.toMatchObject({ code: "ORGANIZATION_HAS_ACTIVE_CLUBS" });
    await expect(setDirectoryOrganizationActive("club-1", false, "admin-1")).rejects.toBeInstanceOf(OrganizationOperationError);
    await expect(setDirectoryOrganizationActive("missing", true, "admin-1")).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("audits each status change", async () => {
    await commitEadventistImport(fixture, "admin-1");
    await setDirectoryOrganizationActive(byName("Sample Pines Camp").id, false, "admin-2");
    await setDirectoryOrganizationActive(byName("Sample Pines Camp").id, true, "admin-2");
    expect(state.audit.slice(1)).toMatchObject([
      { actorUserId: "admin-2", action: "ORGANIZATION_MARKED_INACTIVE" },
      { actorUserId: "admin-2", action: "ORGANIZATION_MARKED_ACTIVE" },
    ]);
  });
});
