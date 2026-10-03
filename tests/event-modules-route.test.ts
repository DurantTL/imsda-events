import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 2: the enable/disable route. System administrators only, same-origin
 * only, audited, and turning a module off never deletes the data behind it. Uses
 * the real route and service against a fake database. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn(), getCurrentSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }),
  isServerEnvironmentError: () => false,
}));

import { DELETE, PUT } from "@/app/api/events/[eventId]/modules/[moduleKey]/route";

const systemAdmin = { id: "user-admin", globalRole: "SYSTEM_ADMIN" as const };
const eventAdmin = { id: "user-event-admin", globalRole: null };

function table(eventIds: string[] = []) {
  return {
    deleteMany: vi.fn(), delete: vi.fn(), updateMany: vi.fn(),
    groupBy: vi.fn(async ({ where }: { where: { eventId: { in: string[] } } }) => eventIds.filter((id) => where.eventId.in.includes(id)).map((eventId) => ({ eventId }))),
  };
}

function fakePrisma(initial: Array<{ eventId: string; moduleKey: string }> = [], data: { products?: string[] } = {}) {
  const rows = [...initial];
  const dataTables = {
    honorSession: table(),
    honorOffering: table(),
    honorEnrollment: table(),
    merchandiseProduct: table(data.products),
    communityPost: table(),
    programAssignmentRun: table(),
  };
  const tx = {
    ...dataTables,
    $queryRaw: vi.fn(async () => []),
    event: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "event-1" ? { id: "event-1", audience: "GENERAL" } : where.id === "event-club" ? { id: "event-club", audience: "CLUB" } : null)) },
    moduleRequest: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    eventModule: {
      createMany: vi.fn(async ({ data }: { data: Array<{ eventId: string; moduleKey: string }> }) => {
        let count = 0;
        for (const row of data) {
          if (!rows.some((existing) => existing.eventId === row.eventId && existing.moduleKey === row.moduleKey)) { rows.push(row); count += 1; }
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { eventId: string; moduleKey: string } }) => {
        const kept = rows.filter((row) => !(row.eventId === where.eventId && row.moduleKey === where.moduleKey));
        const count = rows.length - kept.length;
        rows.length = 0;
        rows.push(...kept);
        return { count };
      }),
    },
  };
  mocks.getPrisma.mockReturnValue({ ...tx, $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) });
  return { rows, dataTables, tx };
}

function request(method: "PUT" | "DELETE", origin: string | null = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/events/event-1/modules/merchandise", {
    method,
    headers: origin ? { origin } : {},
  });
}
const context = (moduleKey = "merchandise", eventId = "event-1") => ({ params: Promise.resolve({ eventId, moduleKey }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: systemAdmin });
});

describe("enable/disable route authorization", () => {
  it("refuses an event admin with 403 and changes nothing", async () => {
    const { rows } = fakePrisma();
    mocks.getCurrentSession.mockResolvedValue({ user: eventAdmin });
    const response = await PUT(request("PUT"), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("PERMISSION_DENIED");
    expect(rows).toHaveLength(0);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses an event admin turning a module off, keeping the row", async () => {
    const { rows } = fakePrisma([{ eventId: "event-1", moduleKey: "merchandise" }]);
    mocks.getCurrentSession.mockResolvedValue({ user: eventAdmin });
    const response = await DELETE(request("DELETE"), context());
    expect(response.status).toBe(403);
    expect(rows).toHaveLength(1);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("answers a signed-out request with 401", async () => {
    fakePrisma();
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await PUT(request("PUT"), context())).status).toBe(401);
  });

  it("rejects a cross-origin request before any session or database work", async () => {
    const { rows } = fakePrisma();
    const response = await PUT(request("PUT", "https://elsewhere.example"), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("INVALID_REQUEST_ORIGIN");
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("rejects a request with no Origin header", async () => {
    fakePrisma();
    const response = await DELETE(request("DELETE", null), context());
    expect(response.status).toBe(403);
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
  });
});

describe("enable/disable route behavior", () => {
  it("lets a system admin enable a module and audits it with the event and module", async () => {
    const { rows } = fakePrisma();
    const response = await PUT(request("PUT"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moduleKey: "merchandise", enabled: true, changed: true });
    expect(rows).toEqual([{ eventId: "event-1", moduleKey: "merchandise" }]);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({
      eventId: "event-1",
      actorUserId: "user-admin",
      action: "EVENT_MODULE_ENABLED",
      entityType: "EventModule",
      entityId: "merchandise",
    });
  });

  it("disables with an audit entry and never touches the data behind the module", async () => {
    const { rows, dataTables } = fakePrisma([{ eventId: "event-1", moduleKey: "merchandise" }]);
    const response = await DELETE(request("DELETE"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moduleKey: "merchandise", enabled: false, changed: true });
    expect(rows).toHaveLength(0);
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "EVENT_MODULE_DISABLED", entityId: "merchandise" });
    for (const table of Object.values(dataTables)) {
      expect(table.deleteMany).not.toHaveBeenCalled();
      expect(table.delete).not.toHaveBeenCalled();
      expect(table.updateMany).not.toHaveBeenCalled();
    }
  });

  it("refuses Turn off for a module the event's data keeps on with 409 DATA_KEEPS_ON, changing nothing", async () => {
    const { rows } = fakePrisma([{ eventId: "event-1", moduleKey: "merchandise" }], { products: ["event-1"] });
    const response = await DELETE(request("DELETE"), context());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("DATA_KEEPS_ON");
    expect(rows).toHaveLength(1);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("is idempotent: enabling twice audits once", async () => {
    fakePrisma();
    await PUT(request("PUT"), context());
    const second = await PUT(request("PUT"), context());
    expect((await second.json()).changed).toBe(false);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("refuses a club module on a general event with 409 NOT_APPLICABLE and leaves no row or audit entry", async () => {
    const { rows } = fakePrisma();
    const response = await PUT(request("PUT"), context("club-assignments"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("NOT_APPLICABLE");
    expect(rows).toHaveLength(0);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("allows a club module on a club event, and always lets a leftover club row be turned off on a general event", async () => {
    const { rows } = fakePrisma([{ eventId: "event-1", moduleKey: "event-patches" }]);
    expect((await PUT(request("PUT"), context("club-assignments", "event-club"))).status).toBe(200);
    expect((await DELETE(request("DELETE"), context("event-patches", "event-1"))).status).toBe(200);
    expect(rows).toEqual([{ eventId: "event-club", moduleKey: "club-assignments" }]);
  });

  it("answers an unknown module or event with 404, for DELETE as for PUT, and an always-on module's disable with 409", async () => {
    fakePrisma();
    expect((await PUT(request("PUT"), context("not-a-module"))).status).toBe(404);
    expect((await PUT(request("PUT"), context("merchandise", "missing-event"))).status).toBe(404);
    expect((await DELETE(request("DELETE"), context("merchandise", "missing-event"))).status).toBe(404);
    expect((await DELETE(request("DELETE"), context("public-content"))).status).toBe(409);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
