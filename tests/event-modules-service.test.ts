import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { AccessDeniedError } from "@/modules/access/authorization";
import {
  definitionHasRankedSeminars,
  disableModule,
  enableModule,
  enabledModules,
  EventModuleError,
  isModuleEnabled,
} from "@/modules/event-modules/service";

const admin = { id: "user-admin", globalRole: "SYSTEM_ADMIN" as const };
const eventAdmin = { id: "user-event-admin", globalRole: null };

/** A fake database that records which tables are written, to prove data is never touched. */
function fakePrisma(initial: Array<{ eventId: string; moduleKey: string }> = []) {
  const rows = [...initial];
  const writes: string[] = [];
  const tx = {
    event: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "event-1" ? { id: "event-1" } : null)) },
    eventModule: {
      createMany: vi.fn(async ({ data }: { data: Array<{ eventId: string; moduleKey: string }> }) => {
        writes.push("eventModule.create");
        let count = 0;
        for (const row of data) {
          if (!rows.some((existing) => existing.eventId === row.eventId && existing.moduleKey === row.moduleKey)) { rows.push(row); count += 1; }
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { eventId: string; moduleKey: string } }) => {
        writes.push("eventModule.delete");
        const before = rows.length;
        const kept = rows.filter((row) => !(row.eventId === where.eventId && row.moduleKey === where.moduleKey));
        rows.length = 0;
        rows.push(...kept);
        return { count: before - rows.length };
      }),
    },
    honorSession: { deleteMany: vi.fn(), findMany: vi.fn() },
    merchandiseProduct: { deleteMany: vi.fn(), findMany: vi.fn() },
  };
  const prisma = {
    ...tx,
    eventModule: {
      ...tx.eventModule,
      findMany: vi.fn(async ({ where }: { where: { eventId: string } }) => rows.filter((row) => row.eventId === where.eventId)),
      findUnique: vi.fn(async ({ where }: { where: { eventId_moduleKey: { eventId: string; moduleKey: string } } }) => (
        rows.find((row) => row.eventId === where.eventId_moduleKey.eventId && row.moduleKey === where.eventId_moduleKey.moduleKey) ? { id: "row" } : null
      )),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, tx, rows, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("event module state", () => {
  it("reports stored modules plus public content, which is on for every event", async () => {
    fakePrisma([{ eventId: "event-1", moduleKey: "merchandise" }, { eventId: "event-2", moduleKey: "honors" }, { eventId: "event-1", moduleKey: "retired-key" }]);
    expect([...(await enabledModules("event-1"))].sort()).toEqual(["merchandise", "public-content"]);
    expect(await isModuleEnabled("event-1", "merchandise")).toBe(true);
    expect(await isModuleEnabled("event-1", "honors")).toBe(false);
    expect(await isModuleEnabled("event-with-no-rows", "public-content")).toBe(true);
  });
});

describe("enable and disable", () => {
  it("lets only a system administrator turn a module on or off, and writes nothing otherwise", async () => {
    const { writes } = fakePrisma();
    for (const actor of [eventAdmin, null, undefined]) {
      await expect(enableModule(actor, "event-1", "honors")).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(disableModule(actor, "event-1", "honors")).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(writes).toEqual([]);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    await expect(enableModule(eventAdmin, "event-1", "honors")).rejects.toMatchObject({ status: 403 });
  });

  it("audits enabling with only the event id and module key, once", async () => {
    const { rows } = fakePrisma();
    expect(await enableModule(admin, "event-1", "honors")).toEqual({ changed: true });
    expect(await enableModule(admin, "event-1", "honors")).toEqual({ changed: false });
    expect(rows).toEqual([{ eventId: "event-1", moduleKey: "honors" }]);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = mocks.writeAuditLog.mock.calls[0];
    expect(entry).toMatchObject({
      eventId: "event-1",
      actorUserId: "user-admin",
      action: "EVENT_MODULE_ENABLED",
      metadata: { eventId: "event-1", moduleKey: "honors" },
    });
    expect(Object.keys(entry.metadata).sort()).toEqual(["eventId", "moduleKey"]);
  });

  it("audits disabling, and deletes only the switch, never the data behind the module", async () => {
    const { rows, writes, tx } = fakePrisma([{ eventId: "event-1", moduleKey: "honors" }]);
    expect(await disableModule(admin, "event-1", "honors")).toEqual({ changed: true });
    expect(rows).toEqual([]);
    expect(writes).toEqual(["eventModule.delete"]);
    expect(tx.honorSession.deleteMany).not.toHaveBeenCalled();
    expect(tx.merchandiseProduct.deleteMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "event-1", action: "EVENT_MODULE_DISABLED", metadata: { eventId: "event-1", moduleKey: "honors" } }),
      tx,
    );
    expect(await disableModule(admin, "event-1", "honors")).toEqual({ changed: false });
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("refuses unknown modules, unknown events, and turning public content off", async () => {
    fakePrisma();
    await expect(enableModule(admin, "event-1", "nope")).rejects.toMatchObject({ code: "UNKNOWN_MODULE" });
    await expect(enableModule(admin, "missing", "honors")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    await expect(disableModule(admin, "event-1", "public-content")).rejects.toBeInstanceOf(EventModuleError);
    expect(await enableModule(admin, "event-1", "public-content")).toEqual({ changed: false });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("module defaults and clone copy", () => {
  it("writes the audience defaults, and copies a source's rows without touching data", async () => {
    const created: Array<{ eventId: string; moduleKey: string }> = [];
    const tx = {
      eventModule: {
        createMany: vi.fn(async ({ data }: { data: typeof created }) => { created.push(...data); return { count: data.length }; }),
        findMany: vi.fn(async () => [{ moduleKey: "honors" }, { moduleKey: "merchandise" }]),
      },
    };
    const { writeDefaultModules, copyEventModules } = await import("@/modules/event-modules/defaults");
    await writeDefaultModules(tx as never, "new-club", "CLUB");
    expect(created.map((row) => row.moduleKey).sort()).toEqual(["club-assignments", "event-patches", "honors", "public-content"]);
    created.length = 0;
    await writeDefaultModules(tx as never, "new-general", "GENERAL");
    expect(created).toEqual([{ eventId: "new-general", moduleKey: "public-content" }]);
    created.length = 0;
    expect(await copyEventModules(tx as never, "source", "clone")).toBe(2);
    expect(created).toEqual([{ eventId: "clone", moduleKey: "honors" }, { eventId: "clone", moduleKey: "merchandise" }]);
  });
});

describe("ranked seminar detection", () => {
  const definition = (field: Record<string, unknown>) => ({
    sections: [{ id: "section-1", title: "Seminars", fields: [{ id: "field-1", key: "seminar_preferences", label: "Seminar preferences", helpText: "", type: "RANKED_CHOICE", scope: "ATTENDEE", required: true, options: ["A", "B"], ...field }] }],
  });

  it("finds a ranked-interest field and ignores anything else", () => {
    expect(definitionHasRankedSeminars(definition({ availabilityMode: "RANKED_INTEREST", choiceLimits: {} }))).toBe(true);
    expect(definitionHasRankedSeminars(definition({ availabilityMode: "NONE" }))).toBe(false);
    expect(definitionHasRankedSeminars(definition({ type: "SELECT", availabilityMode: "NONE" }))).toBe(false);
    expect(definitionHasRankedSeminars(definition({ choiceLimits: {} }))).toBe(true);
    expect(definitionHasRankedSeminars(definition({ availabilityMode: null, choiceLimits: {} }))).toBe(true);
    expect(definitionHasRankedSeminars(definition({ availabilityMode: "", choiceLimits: {} }))).toBe(true);
    expect(definitionHasRankedSeminars(definition({ availabilityMode: "", choiceLimits: null }))).toBe(false);
    expect(definitionHasRankedSeminars(definition({}))).toBe(false);
    expect(definitionHasRankedSeminars({ not: "a definition" })).toBe(false);
    expect(definitionHasRankedSeminars(null)).toBe(false);
  });
});
