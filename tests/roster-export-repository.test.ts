import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  getServerEnv: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { sealSecret } from "@/lib/secret-box";
import {
  RosterExportError,
  deleteRosterExportFormat,
  listRosterExportFormats,
  runRosterExport,
  saveRosterExportFormat,
} from "@/modules/club-rosters/export-repository";

type Row = Record<string, unknown> & { id: string };

const now = new Date("2026-10-01T15:00:00Z");
const actor = { accountId: "director-1" };

function fakeDatabase() {
  let sequence = 0;
  const db = { members: [] as Row[], formats: [] as Row[] };
  const client = {
    clubRosterMember: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => db.members
        .filter((row) => (where.sealedBirthDate ? Boolean(row.sealedBirthDate) : true))
        .map((row) => ({ ...row, person: { firstName: row.firstName, lastName: row.lastName }, updatedAt: now })),
    },
    clubRosterExportFormat: {
      findUnique: async ({ where }: { where: { organizationId_name: { organizationId: string; name: string } } }) => db.formats
        .find((row) => row.organizationId === where.organizationId_name.organizationId && row.name === where.organizationId_name.name) ?? null,
      findFirst: async ({ where }: { where: Row }) => db.formats.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null,
      findMany: async ({ where }: { where: Row }) => db.formats
        .filter((row) => row.organizationId === where.organizationId)
        .map((row) => ({ ...row, updatedAt: now })),
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: `format-${++sequence}` }; db.formats.push(row); return { ...row, updatedAt: now }; },
      delete: async ({ where }: { where: Row }) => { db.formats = db.formats.filter((row) => row.id !== where.id); },
    },
  };
  mocks.getPrisma.mockReturnValue(client);
  return db;
}

function addMember(db: ReturnType<typeof fakeDatabase>, row: Partial<Row> & { id: string; firstName: string; lastName: string }) {
  db.members.push({ status: "ACTIVE", role: "Pathfinder", classLevel: "EXPLORER", gender: "FEMALE", attendeeType: "YOUTH", source: "DIRECTOR", ...row });
}

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" });
  mocks.writeAuditLog.mockResolvedValue({});
  db = fakeDatabase();
  addMember(db, {
    id: "member-1",
    firstName: "Ana",
    lastName: "Reyes",
    sealedBirthDate: sealSecret("2014-05-06", "club-roster:birth-date"),
  });
});

describe("running a roster export (#490)", () => {
  it("builds the same table for a preview and for the CSV it hands out", async () => {
    const columns = [{ key: "firstName" as const, header: "First" }, { key: "lastName" as const, header: "Last" }];
    const preview = await runRosterExport("club-1", "2026-27", { mode: "preview", columns, confirmSensitive: false }, false, actor);
    const csvResult = await runRosterExport("club-1", "2026-27", { mode: "csv", columns, confirmSensitive: false }, false, actor);
    expect(preview.headers).toEqual(csvResult.headers);
    expect(preview.rows).toEqual(csvResult.rows);
    expect("csv" in csvResult && csvResult.csv).toBe('"First","Last"\r\n"Ana","Reyes"\r\n');
  });

  it("requires confirmation before including a sensitive column", async () => {
    const columns = [{ key: "birthDate" as const, header: "DOB" }];
    await expect(runRosterExport("club-1", "2026-27", { mode: "preview", columns, confirmSensitive: false }, true, actor))
      .rejects.toBeInstanceOf(RosterExportError);
    await expect(runRosterExport("club-1", "2026-27", { mode: "preview", columns, confirmSensitive: false }, true, actor))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("refuses a birth-date column without the roster's birth-date access, even confirmed", async () => {
    const columns = [{ key: "birthDate" as const, header: "DOB" }];
    await expect(runRosterExport("club-1", "2026-27", { mode: "preview", columns, confirmSensitive: true }, false, actor))
      .rejects.toMatchObject({ code: "SENSITIVE_ACCESS_DENIED" });
  });

  it("opens birth dates only when authorized and confirmed, and returns the real value", async () => {
    const columns = [{ key: "birthDate" as const, header: "DOB" }];
    const result = await runRosterExport("club-1", "2026-27", { mode: "preview", columns, confirmSensitive: true }, true, actor);
    expect(result.rows).toEqual([["2014-05-06"]]);
  });

  it("audits a CSV export with the club and columns, never a name or birth date", async () => {
    const columns = [{ key: "firstName" as const, header: "First" }, { key: "birthDate" as const, header: "DOB" }];
    await runRosterExport("club-1", "2026-27", { mode: "csv", columns, confirmSensitive: true }, true, actor);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = mocks.writeAuditLog.mock.calls[0]!;
    expect(entry).toMatchObject({
      action: "CLUB_ROSTER_EXPORTED",
      entityType: "Organization",
      entityId: "club-1",
      metadata: { organizationId: "club-1", clubYear: "2026-27", columns: ["firstName", "birthDate"], rowCount: 1 },
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("Ana");
    expect(serialized).not.toContain("Reyes");
    expect(serialized).not.toContain("2014-05-06");
  });

  it("never audits a preview alone", async () => {
    const columns = [{ key: "firstName" as const, header: "First" }];
    await runRosterExport("club-1", "2026-27", { mode: "preview", columns, confirmSensitive: false }, false, actor);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("saved export formats (#490)", () => {
  it("saves structure only — column keys, order, and header names, never a roster row", async () => {
    const format = await saveRosterExportFormat(
      "club-1",
      { name: "NAD Camporee", columns: [{ key: "lastName", header: "Surname" }, { key: "firstName", header: "Given name" }] },
      actor,
    );
    expect(format.columns).toEqual([{ key: "lastName", header: "Surname" }, { key: "firstName", header: "Given name" }]);
    const stored = db.formats[0]!;
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("Ana");
    expect(serialized).not.toContain("Reyes");
    expect(serialized).not.toContain("2014-05-06");
  });

  it("refuses a second format with the same name for the same club", async () => {
    await saveRosterExportFormat("club-1", { name: "NAD Camporee", columns: [{ key: "firstName", header: "First" }] }, actor);
    await expect(saveRosterExportFormat("club-1", { name: "NAD Camporee", columns: [{ key: "lastName", header: "Last" }] }, actor))
      .rejects.toMatchObject({ code: "FORMAT_NAME_TAKEN" });
  });

  it("lists a club's saved formats, and reuse builds the same table as before", async () => {
    await saveRosterExportFormat("club-1", { name: "NAD Camporee", columns: [{ key: "lastName", header: "Last" }] }, actor);
    const formats = await listRosterExportFormats("club-1");
    expect(formats).toHaveLength(1);
    const reused = await runRosterExport("club-1", "2026-27", { mode: "preview", columns: formats[0]!.columns, confirmSensitive: false }, false, actor);
    expect(reused.rows).toEqual([["Reyes"]]);
  });

  it("deletes a saved format, and refuses one that doesn't belong to this club", async () => {
    const format = await saveRosterExportFormat("club-1", { name: "NAD Camporee", columns: [{ key: "firstName", header: "First" }] }, actor);
    await expect(deleteRosterExportFormat("club-2", format.id, actor)).rejects.toMatchObject({ code: "FORMAT_NOT_FOUND" });
    await deleteRosterExportFormat("club-1", format.id, actor);
    expect(await listRosterExportFormats("club-1")).toEqual([]);
  });
});
