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
  deleteHonorOffering,
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
    /** One row per honor a class teaches (#812); the database trigger writes the primary's. */
    offeringHonors: [] as Row[],
    /** One row per prerequisite honor of a class (#832). */
    offeringPrerequisites: [] as Row[],
    locations: [] as Row[],
    /** Enrollments by offering, for the "clubs already picked" guard (#589). */
    pickedOfferingIds: [] as string[],
    /** The club (organization) behind the picks of an offering; "org-a" when unset. */
    pickOrganizations: {} as Record<string, string>,
    /** Makes the next class update hit the (sessionId, honorId) unique index, as a concurrent save would. */
    failNextOfferingUpdateWithUnique: false,
    /** Offerings whose picks were already written back into members' honor records. */
    writtenBackOfferingIds: [] as string[],
    /** Honors written back as completed for enrollees of a class, with how many students (#812). */
    writtenBackHonors: [] as Array<{ offeringId: string; honorId: string; count: number }>,
    /** Events where a club registers several teams (#809). */
    teamEvents: [] as string[],
  };
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "honors") {
        const wanted = (value as { some: { honorId: { in: string[] } } }).some.honorId.in;
        return db.offeringHonors.some((join) => join.offeringId === row.id && wanted.includes(join.honorId as string));
      }
      if (value && typeof value === "object" && "not" in value) return row[key] !== (value as { not: unknown }).not;
      if (value && typeof value === "object" && "in" in value) return (value as { in: unknown[] }).in.includes(row[key]);
      return row[key] === value;
    });
  const honorRowsOf = (offeringId: unknown) => db.offeringHonors
    .filter((row) => row.offeringId === offeringId)
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map((row) => ({ ...row, honor: db.honors.find((honor) => honor.id === row.honorId) }));
  const withOfferingRelations = (offering: Row) => ({
    ...offering,
    honors: honorRowsOf(offering.id),
    prerequisites: db.offeringPrerequisites.filter((row) => row.offeringId === offering.id).map((row) => ({ ...row, honor: db.honors.find((honor) => honor.id === row.honorId) })),
    honor: db.honors.find((honor) => honor.id === offering.honorId),
    session: db.sessions.find((session) => session.id === offering.sessionId) ?? null,
    site: db.locations.find((location) => location.id === offering.locationId) ?? null,
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
      count: async ({ where }: { where: { offeringId?: string | { in: string[] }; offering?: { sessionId: string } } }) => db.pickedOfferingIds
        .filter((offeringId) => {
          if (typeof where.offeringId === "string") return offeringId === where.offeringId;
          if (where.offeringId) return where.offeringId.in.includes(offeringId);
          return db.offerings.find((offering) => offering.id === offeringId)?.sessionId === where.offering?.sessionId;
        }).length,
      findMany: async ({ where }: { where: { offeringId: { in: string[] } } }) => db.pickedOfferingIds
        .filter((offeringId) => where.offeringId.in.includes(offeringId))
        .map((offeringId) => ({ offeringId, organizationId: db.pickOrganizations[offeringId] ?? "org-a" })),
      deleteMany: async ({ where }: { where: { offeringId: { in: string[] } } }) => {
        db.pickedOfferingIds = db.pickedOfferingIds.filter((offeringId) => !where.offeringId.in.includes(offeringId));
      },
    },
    $executeRaw: async () => 1,
    honorWeekendCompletionLink: {
      groupBy: async ({ where }: { where: { honorId: { in: string[] }; enrollment: { offeringId: string } } }) => db.writtenBackHonors
        .filter((row) => row.offeringId === where.enrollment.offeringId && where.honorId.in.includes(row.honorId))
        .map((row) => ({ honorId: row.honorId, _count: { _all: row.count } })),
      count: async ({ where }: { where: { enrollment: { offeringId: { in: string[] } } } }) =>
        db.pickedOfferingIds.filter((offeringId) => where.enrollment.offeringId.in.includes(offeringId) && db.writtenBackOfferingIds.includes(offeringId)).length,
    },
    eventLocation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => db.locations.filter((location) => matches(location, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => db.locations.find((location) => matches(location, where)) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) => db.locations.filter((location) => matches({ isActive: true, ...location }, where)).length,
    },
    event: { findUnique: async ({ where }: { where: Row }) => db.events.find((event) => event.id === where.id) ?? null },
    // Team rules (#809): none unless a test turns teams on for an event.
    eventTeamSettings: { findUnique: async ({ where }: { where: Row }) => (db.teamEvents.includes(where.eventId as string) ? { allowMultipleTeams: true } : null) },
    honor: {
      findUnique: async ({ where }: { where: Row }) => db.honors.find((honor) => honor.id === where.id) ?? null,
      findMany: async (args?: { where?: { id?: { in: string[] } } }) => db.honors
        .filter((honor) => !args?.where?.id || args.where.id.in.includes(honor.id))
        .map((honor) => ({
          ...honor,
          updatedAt: now,
          _count: { offeringHonors: db.offeringHonors.filter((row) => row.honorId === honor.id).length },
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
        const row: Row = { isActive: true, teacherName: "", location: "", ...data, id: id("offering"), updatedAt: now };
        db.offerings.push(row);
        // The migration's trigger: a new class always gets its primary honor's row.
        db.offeringHonors.push({ id: id("hoh"), offeringId: row.id, honorId: row.honorId, eventId: row.eventId, position: 0 });
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        if (db.failNextOfferingUpdateWithUnique) {
          db.failNextOfferingUpdateWithUnique = false;
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
        }
        const row = db.offerings.find((offering) => offering.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        db.offerings = db.offerings.filter((offering) => !where.id.in.includes(offering.id));
        db.offeringHonors = db.offeringHonors.filter((row) => db.offerings.some((offering) => offering.id === row.offeringId));
        db.offeringPrerequisites = db.offeringPrerequisites.filter((row) => db.offerings.some((offering) => offering.id === row.offeringId));
      },
    },
    honorOfferingPrerequisite: {
      findMany: async ({ where }: { where: { offeringId: string } }) => db.offeringPrerequisites.filter((row) => row.offeringId === where.offeringId),
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) db.offeringPrerequisites.push({ ...row, id: id("prereq") });
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { offeringId: string; honorId: { notIn: string[] } } }) => {
        db.offeringPrerequisites = db.offeringPrerequisites.filter((row) => !(row.offeringId === where.offeringId && !where.honorId.notIn.includes(row.honorId as string)));
      },
    },
    honorOfferingHonor: {
      findMany: async ({ where }: { where: { offeringId: string } }) => db.offeringHonors.filter((row) => row.offeringId === where.offeringId),
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: id("hoh") };
        db.offeringHonors.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(db.offeringHonors.find((row) => row.id === where.id)!, data),
      deleteMany: async ({ where }: { where: { id?: { in: string[] }; offeringId?: string; honorId?: { notIn: string[] } } }) => {
        db.offeringHonors = db.offeringHonors.filter((row) => {
          if (where.id) return !where.id.in.includes(row.id);
          return !(row.offeringId === where.offeringId && !where.honorId!.notIn.includes(row.honorId as string));
        });
      },
    },
  };
  const transaction = vi.fn(async (work: (tx: typeof client) => unknown, options?: { isolationLevel?: string }) => {
    void options;
    return work(client);
  });
  mocks.getPrisma.mockReturnValue({ ...client, $transaction: transaction });
  return { db, transaction, sessionQueries };
}

const offeringInput = ({ honorId, ...overrides }: Record<string, unknown> = {}) => ({
  honorIds: [(honorId as string | undefined) ?? "honor-knots"],
  span: "SINGLE_SESSION" as const,
  sessionId: "sab-a",
  locationId: null,
  capacity: 20,
  minimumAge: null,
  perClubLimit: null,
  additionalCostCents: null,
  requirementNote: "",
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

  it("creates no class or session on an event where a club registers several teams (#809)", async () => {
    fake.db.teamEvents.push("site-a");
    const sessionsBefore = fake.db.sessions.length;
    await expect(createHonorOffering("site-a", offeringInput(), "staff-1")).rejects.toMatchObject({ code: "EVENT_HAS_TEAMS" });
    await expect(createHonorSession("site-a", { name: "Session", locationId: null } as never, "staff-1")).rejects.toMatchObject({ code: "EVENT_HAS_TEAMS" });
    expect(fake.db.offerings).toHaveLength(0);
    expect(fake.db.sessions).toHaveLength(sessionsBefore);
    // Turned off again, the same class is created.
    fake.db.teamEvents.length = 0;
    await expect(createHonorOffering("site-a", offeringInput(), "staff-1")).resolves.toBeDefined();
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

  it("removes an empty session, and a session with unpicked classes together with them (#615)", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await deleteHonorSession("site-a", "sun-a", "staff-1");
    expect(fake.db.sessions.map((session) => session.id)).toEqual(["sab-a"]);
    await deleteHonorSession("site-a", "sab-a", "staff-1");
    expect(fake.db.sessions).toHaveLength(0);
    expect(fake.db.offerings).toHaveLength(0);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({ action: "HONOR_SESSION_DELETED", metadata: { classes: 1, picksRemoved: 0 } });
  });

  it("deletes a class nobody picked, audited", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    await expect(deleteHonorOffering("site-b", offeringId, "staff-1")).rejects.toMatchObject({ code: "OFFERING_NOT_FOUND" });
    expect(fake.db.offerings).toHaveLength(1);
    await deleteHonorOffering("site-a", offeringId, "staff-1");
    expect(fake.db.offerings).toHaveLength(0);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({ action: "HONOR_OFFERING_DELETED", metadata: { picksRemoved: 0 } });
  });

  it("won't delete a picked class without the confirmed pick count, and removes exactly those picks with it", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    fake.db.pickedOfferingIds.push(offeringId, offeringId, "another-offering");
    const refusal = await deleteHonorOffering("site-a", offeringId, "staff-1").catch((error) => error);
    expect(refusal).toMatchObject({ code: "PICKS_NEED_CONFIRMATION", picks: 2 });
    expect(refusal.message).toContain("2 class picks");
    await expect(deleteHonorOffering("site-a", offeringId, "staff-1", 1)).rejects.toMatchObject({ code: "PICKS_NEED_CONFIRMATION", picks: 2 });
    expect(fake.db.offerings).toHaveLength(1);
    expect(fake.db.pickedOfferingIds).toHaveLength(3);
    await deleteHonorOffering("site-a", offeringId, "staff-1", 2);
    expect(fake.db.offerings).toHaveLength(0);
    // No orphaned picks: the deleted class's picks are gone, another class's are untouched.
    expect(fake.db.pickedOfferingIds).toEqual(["another-offering"]);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({ metadata: { picksRemoved: 2 } });
  });

  it("refuses to delete a class whose picks were already written back into member records", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    fake.db.pickedOfferingIds.push(offeringId);
    fake.db.writtenBackOfferingIds.push(offeringId);
    await expect(deleteHonorOffering("site-a", offeringId, "staff-1", 1)).rejects.toMatchObject({ code: "HAS_WRITTEN_BACK_COMPLETIONS" });
    expect(fake.db.offerings).toHaveLength(1);
    expect(fake.db.pickedOfferingIds).toEqual([offeringId]);
  });

  it("counts picks across a session's classes when deleting the session", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-birds" }), "staff-1");
    const [knots, birds] = fake.db.offerings.map((offering) => offering.id);
    fake.db.pickedOfferingIds.push(knots, birds, birds);
    await expect(deleteHonorSession("site-a", "sab-a", "staff-1")).rejects.toMatchObject({ code: "PICKS_NEED_CONFIRMATION", picks: 3 });
    expect(fake.db.sessions.map((session) => session.id)).toContain("sab-a");
    await deleteHonorSession("site-a", "sab-a", "staff-1", 3);
    expect(fake.db.sessions.map((session) => session.id)).toEqual(["sun-a"]);
    expect(fake.db.offerings).toHaveLength(0);
    expect(fake.db.pickedOfferingIds).toHaveLength(0);
  });

  it("audits a delete with ids and counts only: each class's picks and each club's picks (#615)", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-birds" }), "staff-1");
    const [knots, birds] = fake.db.offerings.map((offering) => offering.id);
    fake.db.pickedOfferingIds.push(knots, birds, birds);
    fake.db.pickOrganizations[birds] = "org-b";
    await deleteHonorSession("site-a", "sab-a", "staff-1", 3);
    const audit = mocks.writeAuditLog.mock.calls.at(-1)![0];
    expect(audit.metadata).toEqual({
      classes: 2,
      picksRemoved: 3,
      offerings: [
        { id: knots, honorId: "honor-knots", honorIds: ["honor-knots"], picks: 1 },
        { id: birds, honorId: "honor-birds", honorIds: ["honor-birds"], picks: 2 },
      ],
      organizations: [
        { organizationId: "org-a", picks: 1 },
        { organizationId: "org-b", picks: 2 },
      ],
    });
    // No names in the summary or metadata beyond the session's own.
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Knot|Birds/);
    await createHonorOffering("site-a", offeringInput({ sessionId: "sun-a" }), "staff-1");
    const single = fake.db.offerings.at(-1)!.id;
    fake.db.pickedOfferingIds.push(single);
    await deleteHonorOffering("site-a", single, "staff-1", 1);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0].metadata).toEqual({
      picksRemoved: 1,
      offerings: [{ id: single, honorId: "honor-knots", honorIds: ["honor-knots"], picks: 1 }],
      organizations: [{ organizationId: "org-a", picks: 1 }],
    });
  });

  it("words a written-back refusal for what to deactivate", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    fake.db.pickedOfferingIds.push(offeringId);
    fake.db.writtenBackOfferingIds.push(offeringId);
    await expect(deleteHonorSession("site-a", "sab-a", "staff-1", 1)).rejects.toThrow("Deactivate its classes instead.");
    await expect(deleteHonorOffering("site-a", offeringId, "staff-1", 1)).rejects.toThrow("Deactivate it instead.");
  });

  it("names the new honor in the audit summary when a class changes honor", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-birds"] }, "staff-1");
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0].summary).toBe("Updated the Knot Tying offering and changed its honors to Birds.");
    await updateHonorOffering("site-a", offeringId, { capacity: 3 }, "staff-1");
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0].summary).toBe("Updated the Birds offering.");
  });

  it("maps the unique index on a class edit to OFFERING_CONFLICT, as create does", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    fake.db.failNextOfferingUpdateWithUnique = true;
    await expect(updateHonorOffering("site-a", fake.db.offerings[0].id, { sessionId: "sun-a" }, "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
  });

  it("edits every field of a class: honor, session, span, seats and details", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-birds"], sessionId: "sun-a", capacity: 8, teacherName: "A. Teacher", location: "Room 2", minimumAge: 9, perClubLimit: 2 }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-birds", sessionId: "sun-a", capacity: 8, teacherName: "A. Teacher", location: "Room 2", minimumAge: 9, perClubLimit: 2 });
    await updateHonorOffering("site-a", offeringId, { span: "ALL_SESSIONS", sessionId: null }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ span: "ALL_SESSIONS", sessionId: null });
    await updateHonorOffering("site-a", offeringId, { span: "SINGLE_SESSION", sessionId: "sab-a" }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ span: "SINGLE_SESSION", sessionId: "sab-a", locationId: null });
    await expect(updateHonorOffering("site-a", offeringId, { honorIds: ["honor-old"] }, "staff-1")).rejects.toMatchObject({ code: "HONOR_INACTIVE" });
    await expect(updateHonorOffering("site-a", offeringId, { span: "SINGLE_SESSION", sessionId: "missing" }, "staff-1")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("refuses an edit that would double-book the honor, and one that changes a picked class's placement", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-birds", sessionId: "sun-a" }), "staff-1");
    const [knots, birds] = fake.db.offerings.map((offering) => offering.id);
    await expect(updateHonorOffering("site-a", birds, { honorIds: ["honor-knots"], sessionId: "sab-a" }, "staff-1")).rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
    fake.db.pickedOfferingIds.push(knots);
    await expect(updateHonorOffering("site-a", knots, { sessionId: "sun-a" }, "staff-1")).rejects.toMatchObject({ code: "OFFERING_HAS_PICKS" });
    // The seats, teacher and room of a picked class stay editable.
    await updateHonorOffering("site-a", knots, { capacity: 30, teacherName: "B. Teacher" }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ capacity: 30, teacherName: "B. Teacher", sessionId: "sab-a" });
  });
});

describe("class level and prerequisite honors (#832)", () => {
  const prerequisitesOf = (offeringId: string) => fake.db.offeringPrerequisites.filter((row) => row.offeringId === offeringId).map((row) => row.honorId).sort();

  it("saves the minimum level and prerequisites with a new class, and returns them in the setup", async () => {
    const setup = await createHonorOffering("site-a", offeringInput({ minimumClassLevel: "GUIDE", prerequisiteHonorIds: ["honor-birds"] }), "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ minimumClassLevel: "GUIDE" });
    expect(prerequisitesOf(fake.db.offerings[0].id)).toEqual(["honor-birds"]);
    expect(setup.offerings[0]).toMatchObject({ minimumClassLevel: "GUIDE", prerequisiteHonorIds: ["honor-birds"] });
    expect(setup.offerings[0].prerequisiteHonors.map((honor) => honor.name)).toEqual(["Birds"]);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0].metadata).toMatchObject({ minimumClassLevel: "GUIDE", prerequisiteHonorIds: ["honor-birds"] });
  });

  it("makes a class without either as before", async () => {
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    expect(fake.db.offerings[0].minimumClassLevel ?? null).toBeNull();
    expect(prerequisitesOf(fake.db.offerings[0].id)).toEqual([]);
  });

  it("refuses a prerequisite the class teaches, one that doesn't exist, and a new inactive one", async () => {
    await expect(createHonorOffering("site-a", offeringInput({ prerequisiteHonorIds: ["honor-knots"] }), "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_CONFLICT", message: expect.stringContaining("can't also be a prerequisite") });
    await expect(createHonorOffering("site-a", offeringInput({ prerequisiteHonorIds: ["honor-missing"] }), "staff-1"))
      .rejects.toMatchObject({ code: "HONOR_NOT_FOUND" });
    await expect(createHonorOffering("site-a", offeringInput({ prerequisiteHonorIds: ["honor-old"] }), "staff-1"))
      .rejects.toMatchObject({ code: "HONOR_INACTIVE" });
    expect(fake.db.offerings).toHaveLength(0);
  });

  it("replaces the set on an edit, and leaves it alone when the edit names neither", async () => {
    await createHonorOffering("site-a", offeringInput({ prerequisiteHonorIds: ["honor-birds"], minimumClassLevel: "RANGER" }), "staff-1");
    const offeringId = fake.db.offerings[0].id;
    await updateHonorOffering("site-a", offeringId, { capacity: 3 }, "staff-1");
    expect(prerequisitesOf(offeringId)).toEqual(["honor-birds"]);
    expect(fake.db.offerings[0]).toMatchObject({ minimumClassLevel: "RANGER" });
    await updateHonorOffering("site-a", offeringId, { prerequisiteHonorIds: [], minimumClassLevel: null }, "staff-1");
    expect(prerequisitesOf(offeringId)).toEqual([]);
    expect(fake.db.offerings[0]).toMatchObject({ minimumClassLevel: null });
  });

  it("won't let an edit make the class teach a honor it requires", async () => {
    await createHonorOffering("site-a", offeringInput({ prerequisiteHonorIds: ["honor-birds"] }), "staff-1");
    await expect(updateHonorOffering("site-a", fake.db.offerings[0].id, { honorIds: ["honor-birds"] }, "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
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

  it("copies a class's minimum level and prerequisite honors with it (#832)", async () => {
    const knots = fake.db.offerings.find((offering) => offering.honorId === "honor-knots")!;
    knots.minimumClassLevel = "GUIDE";
    fake.db.offeringPrerequisites.push({ id: "prereq-seed", offeringId: knots.id, honorId: "honor-birds" });
    const plan = await previewHonorCopy("site-b", "site-a");
    await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    const copied = fake.db.offerings.find((offering) => offering.eventId === "site-b" && offering.honorId === "honor-knots")!;
    expect(copied).toMatchObject({ minimumClassLevel: "GUIDE" });
    expect(fake.db.offeringPrerequisites.filter((row) => row.offeringId === copied.id).map((row) => row.honorId)).toEqual(["honor-birds"]);
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

  it("keeps today's uniqueness for sessions with no site, in an event without sites", async () => {
    fake.db.events.push({ id: "site-c", name: "Honors Weekend C" });
    await createHonorSession("site-c", sessionInput(), "staff-1");
    await expect(createHonorSession("site-c", sessionInput(), "staff-1")).rejects.toMatchObject({ code: "SESSION_NAME_CONFLICT" });
  });

  it("requires a site for a new session once the event has an active site", async () => {
    await expect(createHonorSession("site-a", sessionInput(), "staff-1")).rejects.toMatchObject({ code: "LOCATION_REQUIRED" });
    fake.db.locations.forEach((location) => { location.isActive = false; });
    await createHonorSession("site-a", sessionInput(), "staff-1");
    expect(fake.db.sessions.some((session) => session.name === "Sabbath Morning" && !session.locationId)).toBe(true);
  });

  it("won't take a session's site away while the event has active sites", async () => {
    await createHonorSession("site-a", sessionInput({ locationId: "loc-hr" }), "staff-1");
    const session = fake.db.sessions.find((row) => row.name === "Sabbath Morning")!;
    await expect(updateHonorSession("site-a", session.id, { locationId: null }, "staff-1")).rejects.toMatchObject({ code: "LOCATION_REQUIRED" });
  });

  it("renames and reorders a session at a site without touching its site (#615)", async () => {
    const { honorSessionUpdateSchema } = await import("@/modules/honors/schemas");
    await createHonorSession("site-a", sessionInput({ locationId: "loc-hr", sortOrder: 4 }), "staff-1");
    const session = fake.db.sessions.find((row) => row.name === "Sabbath Morning")!;
    // Exactly what the rename request body parses to, through the real route schema.
    await updateHonorSession("site-a", session.id, honorSessionUpdateSchema.parse({ name: "Sabbath Afternoon" }), "staff-1");
    expect(session).toMatchObject({ name: "Sabbath Afternoon", normalizedName: "sabbath afternoon", locationId: "loc-hr", sortOrder: 4 });
    await updateHonorSession("site-a", session.id, honorSessionUpdateSchema.parse({ sortOrder: 2 }), "staff-1");
    expect(session).toMatchObject({ locationId: "loc-hr", sortOrder: 2 });
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
      ["Sabbath Morning (Camp Heritage 1)", null, "CREATE"],
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
      ["Sabbath Morning (Camp Heritage 1)", null],
      ["Sabbath Morning", "b-dm"],
      ["Sunday", null],
    ]);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({ metadata: expect.objectContaining({ sessionsWithoutSite: 1 }) });
  });

  it("never merges same-named sessions of different sites when neither site matches", async () => {
    fake.db.events.push({ id: "site-c", name: "Honors Weekend C" });
    const plan = await previewHonorCopy("site-c", "site-a");
    expect(plan.warnings).toHaveLength(2);
    // Each keeps its own row, named after its old site, so their classes stay apart.
    expect(plan.sessions.map((session) => [session.name, session.action])).toEqual([
      ["Sabbath Morning (Camp Heritage 1)", "CREATE"], ["Sabbath Morning (Des Moines)", "CREATE"], ["Sunday", "CREATE"],
    ]);
    await applyHonorCopy("site-c", "site-a", plan.fingerprint, "staff-1");
    expect(fake.db.sessions.filter((session) => session.eventId === "site-c").map((session) => session.name))
      .toEqual(["Sabbath Morning (Camp Heritage 1)", "Sabbath Morning (Des Moines)", "Sunday"]);
  });
});

describe("all-sessions classes at sites (#589)", () => {
  const allSessions = (overrides: Record<string, unknown> = {}) => offeringInput({ span: "ALL_SESSIONS", sessionId: null, ...overrides });

  beforeEach(() => {
    fake.db.locations.push(
      { id: "loc-hr", eventId: "site-a", name: "Camp Heritage 1", normalizedName: "camp heritage 1", sortOrder: 0 },
      { id: "loc-dm", eventId: "site-a", name: "Des Moines", normalizedName: "des moines", sortOrder: 1 },
      { id: "loc-other", eventId: "site-b", name: "Des Moines", normalizedName: "des moines", sortOrder: 0 },
    );
    fake.db.sessions.find((session) => session.id === "sab-a")!.locationId = "loc-hr";
  });

  it("requires a site when the event has active sites, and refuses another event's site", async () => {
    await expect(createHonorOffering("site-a", allSessions(), "staff-1")).rejects.toMatchObject({ code: "LOCATION_REQUIRED" });
    await expect(createHonorOffering("site-a", allSessions({ locationId: "loc-other" }), "staff-1")).rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });
    await createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1");
    expect(fake.db.offerings.at(-1)).toMatchObject({ span: "ALL_SESSIONS", locationId: "loc-dm" });
  });

  it("lets two sites run the same honor across all sessions, but not one site twice", async () => {
    await createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1");
    await createHonorOffering("site-a", allSessions({ locationId: "loc-hr" }), "staff-1");
    await expect(createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1")).rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
  });

  it("checks the all-sessions clash within a site: a single session at another site is fine", async () => {
    await createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1");
    // sab-a is at Camp Heritage: the same honor there in one session doesn't clash with Des Moines' all-sessions class.
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    // But at Camp Heritage an all-sessions class now clashes with it.
    await expect(createHonorOffering("site-a", allSessions({ locationId: "loc-hr" }), "staff-1")).rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
  });

  it("rejects a site on a single-session class, and takes that class's site from its session", async () => {
    const { honorOfferingInputSchema } = await import("@/modules/honors/schemas");
    expect(honorOfferingInputSchema.safeParse(offeringInput({ locationId: "loc-hr" })).success).toBe(false);
    await createHonorOffering("site-a", offeringInput(), "staff-1");
    expect(fake.db.offerings.at(-1)).toMatchObject({ locationId: null });
  });

  it("won't move an all-sessions class to another site once clubs picked it", async () => {
    await createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1");
    const offeringId = fake.db.offerings.at(-1)!.id;
    fake.db.pickedOfferingIds.push(offeringId);
    await expect(updateHonorOffering("site-a", offeringId, { locationId: "loc-hr" }, "staff-1")).rejects.toMatchObject({ code: "OFFERING_HAS_PICKS" });
    fake.db.pickedOfferingIds.length = 0;
    await updateHonorOffering("site-a", offeringId, { locationId: "loc-hr" }, "staff-1");
    expect(fake.db.offerings.at(-1)).toMatchObject({ locationId: "loc-hr" });
  });

  it("copies an all-sessions class to the same-named site, and warns and drops its site when there is no match", async () => {
    fake.db.locations.push({ id: "b-dm", eventId: "site-b", name: "DES MOINES", normalizedName: "des moines", sortOrder: 0 });
    fake.db.sessions.length = 0;
    await createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1");
    await createHonorOffering("site-a", allSessions({ honorId: "honor-birds", locationId: "loc-hr" }), "staff-1");
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.offerings.map((row) => [row.honorName, row.siteName])).toEqual([["Knot Tying", "DES MOINES"], ["Birds", null]]);
    expect(plan.warnings).toEqual([expect.stringContaining("Camp Heritage 1")]);
    await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    const copied = fake.db.offerings.filter((offering) => offering.eventId === "site-b");
    expect(copied.map((offering) => [offering.honorId, offering.locationId ?? null]).sort())
      .toEqual([["honor-birds", null], ["honor-knots", "b-dm"]]);
  });

  it("gives an offering skipped because its site merged with another its own reason", async () => {
    // Two sites' all-sessions Knot Tying, neither matching the target (site-c has no sites).
    fake.db.events.push({ id: "site-c", name: "Honors Weekend C" });
    fake.db.sessions.length = 0;
    await createHonorOffering("site-a", allSessions({ locationId: "loc-dm" }), "staff-1");
    await createHonorOffering("site-a", allSessions({ locationId: "loc-hr" }), "staff-1");
    const plan = await previewHonorCopy("site-c", "site-a");
    const actions = plan.offerings.map((row) => [row.action, row.reason ?? ""]);
    expect(actions[0]).toEqual(["CREATE", ""]);
    expect(actions[1][0]).toBe("SKIP");
    expect(actions[1][1]).toContain("site has no match");
    expect(actions[1][1]).not.toContain("Already set up");
  });
});

describe("site moves run serializable, so a concurrent pick can't be missed (#589)", () => {
  beforeEach(() => {
    fake.db.locations.push(
      { id: "loc-hr", eventId: "site-a", name: "Camp Heritage 1", normalizedName: "camp heritage 1", sortOrder: 0 },
      { id: "loc-dm", eventId: "site-a", name: "Des Moines", normalizedName: "des moines", sortOrder: 1 },
    );
  });

  it("moves a session and an all-sessions class inside a serializable transaction", async () => {
    await updateHonorSession("site-a", "sab-a", { locationId: "loc-dm" }, "staff-1");
    await createHonorOffering("site-a", offeringInput({ span: "ALL_SESSIONS", sessionId: null, locationId: "loc-dm" }), "staff-1");
    const offeringId = fake.db.offerings.at(-1)!.id;
    await updateHonorOffering("site-a", offeringId, { locationId: "loc-hr" }, "staff-1");
    const serializableCalls = fake.transaction.mock.calls.filter(([, options]) => options?.isolationLevel === Prisma.TransactionIsolationLevel.Serializable);
    // create offering + update session + update offering
    expect(serializableCalls.length).toBeGreaterThanOrEqual(3);
    expect(fake.transaction.mock.calls.at(-1)![1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  it("retries a serialization failure instead of missing the pick", async () => {
    let first = true;
    const original = fake.transaction.getMockImplementation()!;
    fake.transaction.mockImplementation(async (work, options) => {
      if (first) {
        first = false;
        throw new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
      }
      return original(work, options);
    });
    await updateHonorSession("site-a", "sab-a", { locationId: "loc-dm" }, "staff-1");
    expect(fake.db.sessions.find((session) => session.id === "sab-a")!.locationId).toBe("loc-dm");
  });
});

describe("a class that teaches several honors (#812)", () => {
  beforeEach(() => {
    fake.db.honors.push({ id: "honor-fire", code: "RE-001", name: "Fire Building", isActive: true });
  });

  it("creates one class with every honor, the first as primary, and shows them all in setup", async () => {
    const setup = await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-birds", "honor-fire"] }), "staff-1");
    expect(fake.db.offerings).toHaveLength(1);
    expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-knots" });
    expect(fake.db.offeringHonors.map((row) => [row.honorId, row.position])).toEqual([["honor-knots", 0], ["honor-birds", 1], ["honor-fire", 2]]);
    expect(setup.offerings[0]).toMatchObject({
      honorIds: ["honor-knots", "honor-birds", "honor-fire"],
      honorName: "Knot Tying + Birds + Fire Building",
      honorCode: "AR-011 + NA-005 + RE-001",
    });
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({
      summary: "Offered Knot Tying + Birds + Fire Building with 20 youth seats.",
      metadata: expect.objectContaining({ honorIds: ["honor-knots", "honor-birds", "honor-fire"] }),
    });
  });

  it("refuses an inactive or unknown honor anywhere in the list, naming it", async () => {
    await expect(createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-old"] }), "staff-1"))
      .rejects.toMatchObject({ code: "HONOR_INACTIVE", message: "Retired Honor is inactive in the catalog." });
    await expect(createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "missing"] }), "staff-1"))
      .rejects.toMatchObject({ code: "HONOR_NOT_FOUND" });
    expect(fake.db.offerings).toHaveLength(0);
  });

  it("refuses the same honor in a second class of one session, whichever honor of the class it is, but not in another session", async () => {
    await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-birds"] }), "staff-1");
    await expect(createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-fire", "honor-birds"] }), "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_CONFLICT", message: expect.stringContaining("Birds: This honor is already offered in that session.") });
    await expect(createHonorOffering("site-a", offeringInput({ honorId: "honor-knots" }), "staff-1")).rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
    await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-fire", "honor-birds"], sessionId: "sun-a" }), "staff-1");
    expect(fake.db.offerings).toHaveLength(2);
  });

  it("refuses a multi-honor all-sessions class when any of its honors is already taught in a single session", async () => {
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-birds" }), "staff-1");
    await expect(createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-fire", "honor-birds"], span: "ALL_SESSIONS", sessionId: null }), "staff-1"))
      .rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
  });

  it("changes and reorders the honors of a class nobody has picked, keeping the primary in step", async () => {
    await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-birds"] }), "staff-1");
    const offeringId = fake.db.offerings[0].id as string;
    await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-birds", "honor-fire"] }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-birds" });
    expect(fake.db.offeringHonors.filter((row) => row.offeringId === offeringId).map((row) => [row.honorId, row.position]).sort())
      .toEqual([["honor-birds", 0], ["honor-fire", 1]]);
    await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-fire", "honor-birds"] }, "staff-1");
    expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-fire" });
  });

  it("checks a changed honor list against the other classes of the session", async () => {
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-fire" }), "staff-1");
    await createHonorOffering("site-a", offeringInput({ honorId: "honor-knots" }), "staff-1");
    const knots = fake.db.offerings[1].id as string;
    await expect(updateHonorOffering("site-a", knots, { honorIds: ["honor-knots", "honor-fire"] }, "staff-1")).rejects.toMatchObject({ code: "OFFERING_CONFLICT" });
    expect(fake.db.offeringHonors.filter((row) => row.offeringId === knots)).toHaveLength(1);
  });

  describe("after people enrolled in the class", () => {
    let offeringId: string;
    beforeEach(async () => {
      await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-birds"] }), "staff-1");
      offeringId = fake.db.offerings[0].id as string;
      fake.db.pickedOfferingIds.push(offeringId, offeringId);
    });
    const honorsOf = () => fake.db.offeringHonors.filter((row) => row.offeringId === offeringId).map((row) => row.honorId).sort();

    it("asks for the enrolled count before the honors change, and says who will take what", async () => {
      await expect(updateHonorOffering("site-a", offeringId, { honorIds: ["honor-knots", "honor-birds", "honor-fire"] }, "staff-1"))
        .rejects.toMatchObject({
          code: "HONORS_NEED_CONFIRMATION",
          picks: 2,
          message: "2 people are enrolled. They will now take: Knot Tying + Birds + Fire Building.",
        });
      await expect(updateHonorOffering("site-a", offeringId, { honorIds: ["honor-knots", "honor-birds", "honor-fire"], confirmEnrolled: 1 }, "staff-1"))
        .rejects.toMatchObject({ code: "HONORS_NEED_CONFIRMATION", picks: 2 });
      expect(honorsOf()).toEqual(["honor-birds", "honor-knots"]);
    });

    it("adds an honor once the count is confirmed", async () => {
      await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-knots", "honor-birds", "honor-fire"], confirmEnrolled: 2 }, "staff-1");
      expect(honorsOf()).toEqual(["honor-birds", "honor-fire", "honor-knots"]);
    });

    it("removes an honor once the count is confirmed", async () => {
      await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-knots"], confirmEnrolled: 2 }, "staff-1");
      expect(honorsOf()).toEqual(["honor-knots"]);
      expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-knots" });
    });

    it("refuses removing an honor already recorded as completed, with the number of students", async () => {
      fake.db.writtenBackHonors.push({ offeringId, honorId: "honor-birds", count: 2 });
      await expect(updateHonorOffering("site-a", offeringId, { honorIds: ["honor-knots"], confirmEnrolled: 2 }, "staff-1"))
        .rejects.toMatchObject({
          code: "HAS_WRITTEN_BACK_COMPLETIONS",
          message: "Birds was already recorded as completed for 2 people in this class, so it can't be removed. Void those records first.",
        });
      expect(honorsOf()).toEqual(["honor-birds", "honor-knots"]);
      // Another honor can still be removed, and honors can still be added.
      await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-birds", "honor-fire"], confirmEnrolled: 2 }, "staff-1");
      expect(honorsOf()).toEqual(["honor-birds", "honor-fire"]);
    });

    it("needs no confirmation to reorder the same honors, or to change seats, teacher and room", async () => {
      await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-birds", "honor-knots"], capacity: 30, teacherName: "A. Teacher" }, "staff-1");
      expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-birds", capacity: 30, teacherName: "A. Teacher" });
    });

    it("still refuses moving the class to another session or span", async () => {
      await expect(updateHonorOffering("site-a", offeringId, { sessionId: "sun-a" }, "staff-1")).rejects.toMatchObject({ code: "OFFERING_HAS_PICKS" });
    });

    it("keeps an honor the catalog has since turned off", async () => {
      fake.db.honors.find((honor) => honor.id === "honor-birds")!.isActive = false;
      await updateHonorOffering("site-a", offeringId, { honorIds: ["honor-birds", "honor-knots"] }, "staff-1");
      expect(fake.db.offerings[0]).toMatchObject({ honorId: "honor-birds" });
    });
  });

  it("deleting a class removes every honor row and audits all the honor ids", async () => {
    await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-birds"] }), "staff-1");
    const offeringId = fake.db.offerings[0].id as string;
    await deleteHonorOffering("site-a", offeringId, "staff-1");
    expect(fake.db.offeringHonors).toHaveLength(0);
    expect(mocks.writeAuditLog.mock.calls.at(-1)![0]).toMatchObject({
      summary: "Removed the Knot Tying + Birds offering and 0 picks.",
      metadata: { offerings: [expect.objectContaining({ id: offeringId, honorIds: ["honor-knots", "honor-birds"] })] },
    });
  });

  it("copies a multi-honor class whole, and skips it when any honor is inactive", async () => {
    await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-knots", "honor-birds"] }), "staff-1");
    await createHonorOffering("site-a", offeringInput({ honorId: undefined, honorIds: ["honor-fire"], sessionId: "sun-a" }), "staff-1");
    fake.db.honors.find((honor) => honor.id === "honor-fire")!.isActive = false;
    const plan = await previewHonorCopy("site-b", "site-a");
    expect(plan.offerings.map((row) => [row.honorName, row.action])).toEqual([["Knot Tying + Birds", "CREATE"], ["Fire Building", "SKIP"]]);
    const { setup } = await applyHonorCopy("site-b", "site-a", plan.fingerprint, "staff-1");
    expect(setup.offerings).toEqual([expect.objectContaining({ honorIds: ["honor-knots", "honor-birds"], honorName: "Knot Tying + Birds" })]);
  });
});
