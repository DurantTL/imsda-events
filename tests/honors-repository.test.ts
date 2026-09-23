import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { Prisma } from "@prisma/client";
import { applyHonorCopy, previewHonorCopy } from "@/modules/honors/copy";
import {
  createHonor,
  createHonorOffering,
  deleteHonorSession,
  updateHonorOffering,
} from "@/modules/honors/repository";

type Row = Record<string, unknown> & { id: string };

/** A small in-memory stand-in for the Prisma calls the honors module makes. */
function fakeDatabase() {
  let sequence = 0;
  const now = new Date("2026-10-01T00:00:00Z");
  const db = {
    events: [{ id: "site-a", name: "Honors Weekend A" }, { id: "site-b", name: "Honors Weekend B" }] as Row[],
    honors: [] as Row[],
    sessions: [] as Row[],
    offerings: [] as Row[],
  };
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const withOfferingRelations = (offering: Row) => ({
    ...offering,
    honor: db.honors.find((honor) => honor.id === offering.honorId),
  });
  const withSessionCount = (session: Row) => ({
    ...session,
    _count: { offerings: db.offerings.filter((offering) => offering.sessionId === session.id).length },
  });

  const client = {
    honorEnrollment: { groupBy: async () => [] },
    event: { findUnique: async ({ where }: { where: Row }) => db.events.find((event) => event.id === where.id) ?? null },
    honor: {
      findUnique: async ({ where }: { where: Row }) => db.honors.find((honor) => honor.id === where.id) ?? null,
      findMany: async () => db.honors.map((honor) => ({
        ...honor,
        updatedAt: now,
        _count: { offerings: db.offerings.filter((offering) => offering.honorId === honor.id).length },
      })),
      create: async ({ data }: { data: Row }) => {
        if (db.honors.some((honor) => honor.code === data.code)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
        }
        const row = { ...data, id: id("honor") };
        db.honors.push(row);
        return row;
      },
    },
    honorSession: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.sessions.filter((session) => matches(session, where)).map(withSessionCount),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const session = db.sessions.find((row) => matches(row, where));
        return session ? withSessionCount(session) : null;
      },
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: id("session") };
        db.sessions.push(row);
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        db.sessions = db.sessions.filter((session) => session.id !== where.id);
      },
    },
    honorOffering: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.offerings.filter((offering) => matches(offering, where)).map(withOfferingRelations),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const offering = db.offerings.find((row) => matches(row, where));
        return offering ? withOfferingRelations(offering) : null;
      },
      create: async ({ data }: { data: Row }) => {
        const row = { isActive: true, teacherName: "", location: "", ...data, id: id("offering"), updatedAt: now };
        db.offerings.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.offerings.find((offering) => offering.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  const transaction = vi.fn(async (work: (tx: typeof client) => unknown) => work(client));
  mocks.getPrisma.mockReturnValue({ ...client, $transaction: transaction });
  return { db, transaction };
}

const offeringInput = (overrides: Record<string, unknown> = {}) => ({
  honorId: "honor-knots",
  span: "SINGLE_SESSION" as const,
  sessionId: "sab-a",
  capacity: 20,
  minimumAge: null,
  perClubLimit: null,
  teacherName: "",
  location: "",
  isActive: true,
  ...overrides,
});

let fake: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  fake = fakeDatabase();
  fake.db.honors.push(
    { id: "honor-knots", code: "AR-011", name: "Knot Tying", isActive: true },
    { id: "honor-birds", code: "NA-005", name: "Birds", isActive: true },
    { id: "honor-old", code: "XX-001", name: "Retired Honor", isActive: false },
  );
  fake.db.sessions.push(
    { id: "sab-a", eventId: "site-a", name: "Sabbath", normalizedName: "sabbath", sortOrder: 0 },
    { id: "sun-a", eventId: "site-a", name: "Sunday", normalizedName: "sunday", sortOrder: 1 },
  );
});

describe("honor catalog", () => {
  it("stores codes upper-cased and reports a duplicate code clearly", async () => {
    await createHonor({ code: " pa-001 ", name: "Camping Skills I", description: "", isActive: true }, "admin-1");
    expect(fake.db.honors.at(-1)).toMatchObject({ code: "PA-001", normalizedName: "camping skills i" });
    await expect(createHonor({ code: "PA-001", name: "Other", description: "", isActive: true }, "admin-1"))
      .rejects.toMatchObject({ code: "HONOR_CODE_CONFLICT" });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "HONOR_CREATED" });
  });
});

describe("honor offerings", () => {
  it("adds a class, audits it, and uses a serializable transaction", async () => {
    const setup = await createHonorOffering("site-a", offeringInput({ minimumAge: 10, perClubLimit: 3 }), "staff-1");
    expect(setup.offerings).toEqual([expect.objectContaining({ honorName: "Knot Tying", capacity: 20, perClubLimit: 3 })]);
    expect(fake.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "HONOR_OFFERING_CREATED", eventId: "site-a" });
  });

  it("refuses a duplicate in the same session and an all-sessions clash", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await expect(createHonorOffering("site-a", offeringInput(), "staff-1")).rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
    await expect(createHonorOffering("site-a", offeringInput({ span: "ALL_SESSIONS", sessionId: null }), "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
    expect(fake.db.offerings).toHaveLength(1);
  });

  it("refuses inactive honors and another site's session", async () => {
    await expect(createHonorOffering("site-a", offeringInput({ honorId: "honor-old" }), "staff-1"))
      .rejects.toMatchObject({ code: "HONOR_INACTIVE" });
    fake.db.sessions.push({ id: "sab-b", eventId: "site-b", name: "Sabbath", normalizedName: "sabbath", sortOrder: 0 });
    await expect(createHonorOffering("site-a", offeringInput({ sessionId: "sab-b" }), "staff-1"))
      .rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("only updates a class that belongs to the site", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    await expect(updateHonorOffering("site-b", offeringId, { capacity: 1 }, "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_NOT_FOUND" });
    await updateHonorOffering("site-a", offeringId, { capacity: 12, isActive: false }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ capacity: 12, isActive: false });
  });

  it("won't remove a session that still has classes", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await expect(deleteHonorSession("site-a", "sab-a", "staff-1")).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    await deleteHonorSession("site-a", "sun-a", "staff-1");
    expect(fake.db.sessions.map((session) => session.id)).toEqual(["sab-a"]);
  });
});

describe("copying a site's classes", () => {
  beforeEach(async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-birds", span: "ALL_SESSIONS", sessionId: null, capacity: 15 }), "staff-1");
    vi.clearAllMocks();
    mocks.writeAuditLog.mockResolvedValue({});
  });

  it("previews without writing anything", async () => {
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.sessions).toEqual([
      { name: "Sabbath", sortOrder: 0, action: "CREATE" },
      { name: "Sunday", sortOrder: 1, action: "CREATE" },
    ]);
    expect(plan).toMatchObject({ createCount: 2, skipCount: 0 });
    expect(fake.db.offerings.filter((offering) => offering.eventId === "site-b")).toHaveLength(0);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("applies exactly the reviewed plan, mapping sessions by name", async () => {
    const plan = await previewHonorCopy("site-b", "site-a");
    await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    const copied = fake.db.offerings.filter((offering) => offering.eventId === "site-b");
    const sessionsB = fake.db.sessions.filter((session) => session.eventId === "site-b");
    expect(sessionsB.map((session) => session.name)).toEqual(["Sabbath", "Sunday"]);
    expect(copied).toEqual(expect.arrayContaining([
      expect.objectContaining({ honorId: "honor-knots", sessionId: sessionsB[0].id, capacity: 20 }),
      expect.objectContaining({ honorId: "honor-birds", sessionId: null, span: "ALL_SESSIONS" }),
    ]));
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "HONOR_OFFERINGS_COPIED", eventId: "site-b" });
  });

  it("never replaces what the target already has", async () => {
    fake.db.sessions.push({ id: "sab-b", eventId: "site-b", name: "SABBATH", normalizedName: "sabbath", sortOrder: 0 });
    await createHonorOffering("site-b", offeringInput({ sessionId: "sab-b", capacity: 5 }), "staff-1");
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.sessions[0]).toMatchObject({ action: "EXISTS" });
    expect(plan.offerings.find((row) => row.honorName === "Knot Tying")).toMatchObject({ action: "SKIP" });
    await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    const knots = fake.db.offerings.filter((offering) => offering.eventId === "site-b" && offering.honorId === "honor-knots");
    expect(knots).toEqual([expect.objectContaining({ capacity: 5 })]);
  });

  it("refuses to apply when either site changed after the preview", async () => {
    const plan = await previewHonorCopy("site-b", "site-a");
    fake.db.sessions.push({ id: "sab-b", eventId: "site-b", name: "Sabbath", normalizedName: "sabbath", sortOrder: 0 });
    await expect(applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1"))
      .rejects.toMatchObject({ code: "COPY_SOURCE_CHANGED" });
    expect(fake.db.offerings.filter((offering) => offering.eventId === "site-b")).toHaveLength(0);
  });

  it("skips inactive catalog honors and refuses copying a site onto itself", async () => {
    fake.db.honors.find((honor) => honor.id === "honor-birds")!.isActive = false;
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.offerings.find((row) => row.honorName === "Birds")).toMatchObject({ action: "SKIP" });
    await expect(previewHonorCopy("site-a", "site-a")).rejects.toMatchObject({ code: "COPY_SAME_EVENT" });
  });
});
