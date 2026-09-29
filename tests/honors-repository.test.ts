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
  createHonorSession,
  deleteHonorSession,
  updateHonorSession,
  getEventHonorSetup,
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
    locations: [] as Row[],
    /** Enrollments by offering, for the "clubs already picked" guard (#589). */
    pickedOfferingIds: [] as string[],
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
    location: db.locations.find((location) => location.id === session.locationId) ?? null,
    _count: { offerings: db.offerings.filter((offering) => offering.sessionId === session.id).length },
  });

  const sessionQueries: Array<{ where: Record<string, unknown>; orderBy?: unknown; select?: unknown }> = [];
  const client = {
    honorEnrollment: {
      groupBy: async () => [],
      count: async ({ where }: { where: { offering: { sessionId: string } } }) => db.pickedOfferingIds
        .filter((offeringId) => db.offerings.find((offering) => offering.id === offeringId)?.sessionId === where.offering.sessionId).length,
    },
    eventLocation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => db.locations.filter((location) => matches(location, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => db.locations.find((location) => matches(location, where)) ?? null,
    },
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
      findMany: async (args: { where: Record<string, unknown>; orderBy?: Array<Record<string, "asc" | "desc">> }) => {
        sessionQueries.push(args);
        const keys = (args.orderBy ?? []).map((entry) => Object.entries(entry)[0]!);
        const compare = (a: Row, b: Row) => {
          for (const [key] of keys) {
            const x = a[key] as number | string | Date | undefined;
            const y = b[key] as number | string | Date | undefined;
            if (x === y || x === undefined || y === undefined) continue;
            return x < y ? -1 : 1;
          }
          return 0;
        };
        return db.sessions.filter((session) => matches(session, args.where)).sort(compare).map(withSessionCount);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const session = db.sessions.find((row) => matches(row, where));
        return session ? withSessionCount(session) : null;
      },
      create: async ({ data }: { data: Row }) => {
        // The database's two partial unique indexes: one name per (event, site), and per event when there is no site.
        if (db.sessions.some((session) => session.eventId === data.eventId && (session.locationId ?? null) === (data.locationId ?? null) && session.normalizedName === data.normalizedName)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
        }
        const row = { ...data, id: id("session") };
        db.sessions.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.sessions.find((session) => session.id === where.id)!;
        const next = { ...row, ...data };
        if (db.sessions.some((session) => session.id !== row.id && session.eventId === next.eventId && (session.locationId ?? null) === (next.locationId ?? null) && session.normalizedName === next.normalizedName)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
        }
        Object.assign(row, data);
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
  return { db, transaction, sessionQueries };
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
      { name: "Sabbath", sortOrder: 0, action: "CREATE", siteName: null, siteWarning: null },
      { name: "Sunday", sortOrder: 1, action: "CREATE", siteName: null, siteWarning: null },
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

describe("honors session order (#570)", () => {
  it("queries sessions by sortOrder, then creation time, then name, and selects createdAt", async () => {
    await getEventHonorSetup("site-a");
    const query = fake.sessionQueries.at(-1)!;
    expect(query.orderBy).toEqual([{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }]);
    expect(query.select).toMatchObject({ createdAt: true, sortOrder: true });
  });

  it("copy renumbers new sessions 0..n in the source's display order, so a tied source keeps Morning before Afternoon", async () => {
    fake.db.sessions.length = 0;
    // Afternoon is stored first and sorts first by name, but Morning was created first.
    fake.db.sessions.push(
      { id: "aft", eventId: "site-a", name: "Sabbath Afternoon", normalizedName: "sabbath afternoon", sortOrder: 0, createdAt: new Date("2026-10-01T11:00:00Z") },
      { id: "mor", eventId: "site-a", name: "Sabbath Morning", normalizedName: "sabbath morning", sortOrder: 0, createdAt: new Date("2026-10-01T10:00:00Z") },
    );
    await createHonorOffering("site-a", offeringInput({ sessionId: "mor" }), "staff-1");
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.sessions.map((session) => [session.name, session.sortOrder])).toEqual([
      ["Sabbath Morning", 0],
      ["Sabbath Afternoon", 1],
    ]);
    await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    const copied = fake.db.sessions.filter((session) => session.eventId === "site-b");
    expect(copied.map((session) => [session.name, session.sortOrder])).toEqual([
      ["Sabbath Morning", 0],
      ["Sabbath Afternoon", 1],
    ]);
  });
});

describe("honors sessions at sites (#589)", () => {
  const sessionInput = (overrides: Record<string, unknown> = {}) => ({ name: "Sabbath Morning", sortOrder: 0, locationId: null, ...overrides });

  beforeEach(() => {
    fake.db.locations.push(
      { id: "loc-hr", eventId: "site-a", name: "Camp Heritage 1", normalizedName: "camp heritage 1", sortOrder: 0 },
      { id: "loc-dm", eventId: "site-a", name: "Des Moines", normalizedName: "des moines", sortOrder: 1 },
      { id: "loc-other", eventId: "site-b", name: "Des Moines", normalizedName: "des moines", sortOrder: 0 },
    );
  });

  it("lets two sites reuse a session name but not one site twice", async () => {
    await createHonorSession("site-a", sessionInput({ locationId: "loc-hr" }), "staff-1");
    await createHonorSession("site-a", sessionInput({ locationId: "loc-dm" }), "staff-1");
    await expect(createHonorSession("site-a", sessionInput({ locationId: "loc-dm", name: " sabbath  MORNING " }), "staff-1"))
      .rejects.toMatchObject({ code: "SESSION_NAME_CONFLICT" });
    expect(fake.db.sessions.filter((session) => session.normalizedName === "sabbath morning").map((session) => session.locationId))
      .toEqual(["loc-hr", "loc-dm"]);
  });

  it("keeps today's uniqueness for sessions with no site", async () => {
    await createHonorSession("site-a", sessionInput(), "staff-1");
    await expect(createHonorSession("site-a", sessionInput(), "staff-1")).rejects.toMatchObject({ code: "SESSION_NAME_CONFLICT" });
    // A site's session of the same name is a different session.
    await createHonorSession("site-a", sessionInput({ locationId: "loc-hr" }), "staff-1");
  });

  it("refuses a site that belongs to another event", async () => {
    await expect(createHonorSession("site-a", sessionInput({ locationId: "loc-other" }), "staff-1"))
      .rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });
    expect(fake.db.sessions.some((session) => session.name === "Sabbath Morning")).toBe(false);
  });

  it("returns the event's sites and each session's site in the setup", async () => {
    await createHonorSession("site-a", sessionInput({ locationId: "loc-dm" }), "staff-1");
    const setup = await getEventHonorSetup("site-a");
    expect(setup.locations.map((location) => location.name)).toEqual(["Camp Heritage 1", "Des Moines"]);
    expect(setup.sessions.find((session) => session.name === "Sabbath Morning")).toMatchObject({ locationId: "loc-dm" });
  });

  it("won't move a session to another site once clubs picked its classes, and moves it otherwise", async () => {
    await createHonorSession("site-a", sessionInput({ locationId: "loc-hr" }), "staff-1");
    const session = fake.db.sessions.find((row) => row.name === "Sabbath Morning")!;
    await createHonorOffering("site-a", offeringInput({ sessionId: session.id }), "staff-1");
    fake.db.pickedOfferingIds.push(fake.db.offerings.at(-1)!.id);
    await expect(updateHonorSession("site-a", session.id, { locationId: "loc-dm" }, "staff-1"))
      .rejects.toMatchObject({ code: "SESSION_HAS_PICKS" });
    expect(session.locationId).toBe("loc-hr");
    fake.db.pickedOfferingIds.length = 0;
    await updateHonorSession("site-a", session.id, { locationId: "loc-dm" }, "staff-1");
    expect(session.locationId).toBe("loc-dm");
  });
});

describe("copying sessions between events with sites (#589)", () => {
  beforeEach(() => {
    fake.db.sessions.length = 0;
    fake.db.locations.push(
      { id: "a-hr", eventId: "site-a", name: "Camp Heritage 1", normalizedName: "camp heritage 1", sortOrder: 0 },
      { id: "a-dm", eventId: "site-a", name: "Des Moines", normalizedName: "des moines", sortOrder: 1 },
      { id: "b-dm", eventId: "site-b", name: "DES MOINES", normalizedName: "des moines", sortOrder: 0 },
    );
    fake.db.sessions.push(
      { id: "a-hr-sab", eventId: "site-a", locationId: "a-hr", name: "Sabbath Morning", normalizedName: "sabbath morning", sortOrder: 0 },
      { id: "a-dm-sab", eventId: "site-a", locationId: "a-dm", name: "Sabbath Morning", normalizedName: "sabbath morning", sortOrder: 0 },
      { id: "a-shared", eventId: "site-a", locationId: null, name: "Sunday", normalizedName: "sunday", sortOrder: 2 },
    );
  });

  it("maps each session to the same-named site and warns when a site has no match", async () => {
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.sessions.map((session) => [session.name, session.siteName, session.action])).toEqual([
      ["Sabbath Morning", null, "CREATE"],
      ["Sabbath Morning", "DES MOINES", "CREATE"],
      ["Sunday", null, "CREATE"],
    ]);
    expect(plan.warnings).toEqual([expect.stringContaining("Camp Heritage 1")]);
  });

  it("creates sessions at the matched site and leaves the unmatched one with no site", async () => {
    const plan = await previewHonorCopy("site-b", "site-a");
    await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    const copied = fake.db.sessions.filter((session) => session.eventId === "site-b");
    expect(copied.map((session) => [session.name, session.locationId ?? null])).toEqual([
      ["Sabbath Morning", null],
      ["Sabbath Morning", "b-dm"],
      ["Sunday", null],
    ]);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({ metadata: expect.objectContaining({ sessionsWithoutSite: 1 }) });
  });

  it("copies into an event with no sites exactly as before, and warns per site-less target", async () => {
    fake.db.events.push({ id: "site-c", name: "Honors Weekend C" });
    const plan = await previewHonorCopy("site-c", "site-a");
    expect(plan.warnings).toHaveLength(2);
    // Two sessions of the same name that both lose their site collapse into one, rather than breaking the unique name.
    expect(plan.sessions.map((session) => session.action)).toEqual(["CREATE", "EXISTS", "CREATE"]);
    await applyHonorCopy("site-c", "site-a", plan.fingerprint, "staff-1");
    expect(fake.db.sessions.filter((session) => session.eventId === "site-c")).toHaveLength(2);
  });
});
