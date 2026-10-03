import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 review: Merchandise and Seminar assignments show when the event's data
 * needs them, with no stored row, in a fixed number of queries; the ranked seminar
 * check runs in SQL and loads no form definitions. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { definitionHasRankedSeminars, moduleState, moduleStatesByEvent } from "@/modules/event-modules/service";
import { disabledModuleCardKeys } from "@/modules/event-modules/catalog";

const rankedField = { type: "RANKED_CHOICE", availabilityMode: "RANKED_INTEREST" };
const plainField = { type: "TEXT" };
const definition = (field: object) => ({ sections: [{ fields: [field] }] });

type Data = {
  rows?: Array<{ eventId: string; moduleKey: string }>;
  products?: string[];
  runs?: string[];
  honorSessions?: string[];
  honorOfferings?: string[];
  honorEnrollments?: string[];
  versions?: Array<{ eventId: string; definition: unknown }>;
};

function fakePrisma(data: Data) {
  const grouped = (ids: string[] = []) => ({
    groupBy: vi.fn(async ({ where }: { where: { eventId: { in: string[] } } }) => [...new Set(ids)].filter((id) => where.eventId.in.includes(id)).map((eventId) => ({ eventId }))),
  });
  const prisma = {
    eventModule: { findMany: vi.fn(async ({ where }: { where: { eventId: { in: string[] } } }) => (data.rows ?? []).filter((row) => where.eventId.in.includes(row.eventId))) },
    merchandiseProduct: grouped(data.products),
    programAssignmentRun: grouped(data.runs),
    honorSession: grouped(data.honorSessions),
    honorOffering: grouped(data.honorOfferings),
    honorEnrollment: grouped(data.honorEnrollments),
    // The SQL matches ranked-field form versions and returns event ids only; the fake applies the same rule to its fixtures.
    $queryRaw: vi.fn(async (query: { values: unknown[] }) => {
      const ids = query.values[0] as string[];
      return [...new Set((data.versions ?? []).filter((version) => ids.includes(version.eventId) && definitionHasRankedSeminars(version.definition)).map((version) => version.eventId))].map((eventId) => ({ eventId }));
    }),
    registrationFormVersion: { findMany: vi.fn() },
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

describe("module state from data", () => {
  it("shows Merchandise for an event whose first product was added after the backfill, with no row", async () => {
    fakePrisma({ products: ["event-1"] });
    const state = await moduleState("event-1");
    expect(state.stored.has("merchandise")).toBe(false);
    expect(state.effective.has("merchandise")).toBe(true);
    expect(state.dataForced.has("merchandise")).toBe(true);
    expect(disabledModuleCardKeys(state.effective).has("merchandise")).toBe(false);
  });

  it("shows Seminar assignments once a ranked seminar field is added later", async () => {
    fakePrisma({ versions: [{ eventId: "event-1", definition: definition(rankedField) }] });
    const state = await moduleState("event-1");
    expect(state.stored.has("seminar-assignments")).toBe(false);
    expect(state.effective.has("seminar-assignments")).toBe(true);
    expect(state.dataForced.has("seminar-assignments")).toBe(true);
  });

  it("shows Seminar assignments for a clone whose copied forms carry a ranked field, and for an event that has run an assignment", async () => {
    fakePrisma({ versions: [{ eventId: "event-clone", definition: definition(rankedField) }], runs: ["event-ran"] });
    const states = await moduleStatesByEvent(["event-clone", "event-ran", "event-none"]);
    expect(states.get("event-clone")!.effective.has("seminar-assignments")).toBe(true);
    expect(states.get("event-ran")!.effective.has("seminar-assignments")).toBe(true);
    expect(states.get("event-none")!.effective.has("seminar-assignments")).toBe(false);
  });

  it("does not show either module for an event with neither data nor a row, and keeps the row-gated modules row-gated", async () => {
    fakePrisma({ versions: [{ eventId: "event-1", definition: definition(plainField) }] });
    expect([...(await moduleState("event-1")).effective]).toEqual(["public-content"]);
    fakePrisma({ products: ["event-1"], versions: [{ eventId: "event-1", definition: definition(rankedField) }], honorSessions: ["event-1"] });
    const withData = await moduleState("event-1");
    // Honors data makes Honors applicable, not on: it still needs its row.
    for (const key of ["honors", "event-patches", "club-assignments", "attendee-community"] as const) expect(withData.effective.has(key)).toBe(false);
    expect(withData.dataPresent.has("honors")).toBe(true);
    expect(withData.dataForced.has("honors")).toBe(false);
  });

  it("reports honors data from sessions, offerings or enrollments", async () => {
    fakePrisma({ honorSessions: ["a"], honorOfferings: ["b"], honorEnrollments: ["c"] });
    const states = await moduleStatesByEvent(["a", "b", "c", "d"]);
    expect(["a", "b", "c", "d"].map((id) => states.get(id)!.dataPresent.has("honors"))).toEqual([true, true, true, false]);
  });

  it("checks the data even when the row exists, so a stored data-driven module is reported as data-forced", async () => {
    const prisma = fakePrisma({ rows: [{ eventId: "event-1", moduleKey: "merchandise" }], products: ["event-1"] });
    const state = await moduleState("event-1");
    expect(state.effective.has("merchandise")).toBe(true);
    expect(state.dataForced.has("merchandise")).toBe(true);
    expect(prisma.merchandiseProduct.groupBy).toHaveBeenCalledTimes(1);
  });

  it("leaves a stored data-driven module with no data not forced, so it can be turned off", async () => {
    fakePrisma({ rows: [{ eventId: "event-1", moduleKey: "merchandise" }] });
    const state = await moduleState("event-1");
    expect(state.effective.has("merchandise")).toBe(true);
    expect(state.dataForced.has("merchandise")).toBe(false);
  });

  it("checks ranked seminars in one SQL query that returns event ids, never loading form definitions", async () => {
    const prisma = fakePrisma({ versions: [{ eventId: "event-9", definition: definition(rankedField) }] });
    await moduleStatesByEvent(["event-9", "event-8"]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const query = prisma.$queryRaw.mock.calls[0][0] as unknown as { strings?: string[]; sql: string };
    expect(query.sql).toContain("jsonb_path_exists");
    expect(query.sql).toContain("DISTINCT");
    expect(query.sql).toContain('"RANKED_INTEREST"');
    expect(prisma.registrationFormVersion.findMany).not.toHaveBeenCalled();
  });

  it("uses a fixed number of queries however many events there are", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `event-${index}`);
    const prisma = fakePrisma({ products: ["event-3"], versions: [{ eventId: "event-9", definition: definition(rankedField) }] });
    const states = await moduleStatesByEvent(ids);
    expect(prisma.eventModule.findMany).toHaveBeenCalledTimes(1);
    for (const table of [prisma.merchandiseProduct, prisma.programAssignmentRun, prisma.honorSession, prisma.honorOffering, prisma.honorEnrollment]) {
      expect(table.groupBy).toHaveBeenCalledTimes(1);
    }
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(states.get("event-3")!.effective.has("merchandise")).toBe(true);
    expect(states.get("event-9")!.effective.has("seminar-assignments")).toBe(true);
    expect(states.get("event-4")!.effective.has("merchandise")).toBe(false);
  });

  it("returns an empty map and runs no query for no events", async () => {
    const prisma = fakePrisma({});
    expect((await moduleStatesByEvent([])).size).toBe(0);
    expect(prisma.eventModule.findMany).not.toHaveBeenCalled();
  });
});
