import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 review: Merchandise and Seminar assignments show when the event's data
 * needs them, with no stored row, in a fixed number of queries. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { moduleState, moduleStatesByEvent } from "@/modules/event-modules/service";
import { disabledModuleCardKeys } from "@/modules/event-modules/catalog";

const rankedField = { type: "RANKED_CHOICE", availabilityMode: "RANKED_INTEREST" };
const plainField = { type: "TEXT" };
const definition = (field: object) => ({ sections: [{ fields: [field] }] });

function fakePrisma(data: {
  rows?: Array<{ eventId: string; moduleKey: string }>;
  products?: string[];
  runs?: string[];
  versions?: Array<{ eventId: string; definition: unknown }>;
}) {
  const inList = (where: { eventId?: { in: string[] } }) => where.eventId?.in ?? [];
  const prisma = {
    eventModule: { findMany: vi.fn(async ({ where }: { where: { eventId: { in: string[] } } }) => (data.rows ?? []).filter((row) => inList(where).includes(row.eventId))) },
    merchandiseProduct: { groupBy: vi.fn(async ({ where }: { where: { eventId: { in: string[] } } }) => [...new Set(data.products ?? [])].filter((id) => inList(where).includes(id)).map((eventId) => ({ eventId }))) },
    programAssignmentRun: { groupBy: vi.fn(async ({ where }: { where: { eventId: { in: string[] } } }) => [...new Set(data.runs ?? [])].filter((id) => inList(where).includes(id)).map((eventId) => ({ eventId }))) },
    registrationFormVersion: {
      findMany: vi.fn(async ({ where }: { where: { form: { eventId: { in: string[] } } } }) => (data.versions ?? [])
        .filter((version) => where.form.eventId.in.includes(version.eventId))
        .map((version) => ({ definition: version.definition, form: { eventId: version.eventId } }))),
    },
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
    expect(disabledModuleCardKeys(state.effective).has("merchandise")).toBe(false);
  });

  it("shows Seminar assignments once a ranked seminar field is added later", async () => {
    fakePrisma({ versions: [{ eventId: "event-1", definition: definition(rankedField) }] });
    const state = await moduleState("event-1");
    expect(state.stored.has("seminar-assignments")).toBe(false);
    expect(state.effective.has("seminar-assignments")).toBe(true);
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
    const { effective } = await moduleState("event-1");
    expect([...effective]).toEqual(["public-content"]);
    // A product or ranked field never turns on a row-gated module.
    fakePrisma({ products: ["event-1"], versions: [{ eventId: "event-1", definition: definition(rankedField) }] });
    const withData = (await moduleState("event-1")).effective;
    for (const key of ["honors", "event-patches", "club-assignments", "attendee-community"] as const) expect(withData.has(key)).toBe(false);
  });

  it("keeps a stored row on, and never queries data for a module that already has its row", async () => {
    const prisma = fakePrisma({ rows: [{ eventId: "event-1", moduleKey: "merchandise" }, { eventId: "event-1", moduleKey: "seminar-assignments" }] });
    const state = await moduleState("event-1");
    expect(state.effective.has("merchandise")).toBe(true);
    expect(state.effective.has("seminar-assignments")).toBe(true);
    expect(prisma.merchandiseProduct.groupBy).not.toHaveBeenCalled();
    expect(prisma.programAssignmentRun.groupBy).not.toHaveBeenCalled();
    expect(prisma.registrationFormVersion.findMany).not.toHaveBeenCalled();
  });

  it("uses a fixed number of queries however many events there are", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `event-${index}`);
    const prisma = fakePrisma({ products: ["event-3"], versions: [{ eventId: "event-9", definition: definition(rankedField) }] });
    const states = await moduleStatesByEvent(ids);
    expect(prisma.eventModule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.merchandiseProduct.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.programAssignmentRun.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.registrationFormVersion.findMany).toHaveBeenCalledTimes(1);
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
