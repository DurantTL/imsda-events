/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory fake database receives loosely typed Prisma arguments */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 3: module requests. Who may ask, what is refused, the re-request
 * rules, approving (enables the module in the same transaction) and declining
 * (needs a reason), audit contents, and the emails. The fake database keeps
 * rows in memory and the outbox is the local capture: nothing leaves the
 * process and no real recipient exists. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  findActiveMembership: vi.fn(),
  getPlatformSettings: vi.fn(),
  getAccountEmailSender: vi.fn(),
  isAccountEmailConfigured: vi.fn(),
  processAccountEmailQueue: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/system-admin/platform-settings", () => ({ getPlatformSettings: mocks.getPlatformSettings }));
vi.mock("@/modules/communications/account-email", () => ({
  AccountEmailNotConfiguredError: class extends Error {},
  getAccountEmailSender: mocks.getAccountEmailSender,
  isAccountEmailConfigured: mocks.isAccountEmailConfigured,
}));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: mocks.processAccountEmailQueue }));

import { AccessDeniedError, type AuthenticatedUser } from "@/modules/access/authorization";
import {
  createModuleRequest,
  decideModuleRequest,
  listPendingModuleRequests,
  ModuleRequestError,
} from "@/modules/event-modules/requests";
import { neutralizePlaceholders } from "@/modules/event-modules/request-email";
import { enableModule, EventModuleError } from "@/modules/event-modules/service";

const systemAdmin: AuthenticatedUser = { id: "user-admin", email: "admin@imsda-events.test", displayName: "Alex Admin", globalRole: "SYSTEM_ADMIN" } as AuthenticatedUser;
const eventAdmin: AuthenticatedUser = { id: "user-ea", email: "ea@imsda-events.test", displayName: "Eli EventAdmin", globalRole: null } as AuthenticatedUser;
const financeStaff: AuthenticatedUser = { id: "user-fin", email: "fin@imsda-events.test", displayName: "Fran Finance", globalRole: null } as AuthenticatedUser;
const outsider: AuthenticatedUser = { id: "user-out", email: "out@imsda-events.test", displayName: "Oli Outsider", globalRole: null } as AuthenticatedUser;

type RequestRow = {
  id: string; eventId: string; moduleKey: string; requestedByUserId: string | null; reason: string;
  status: "PENDING" | "APPROVED" | "DECLINED"; decidedByUserId: string | null; decidedAt: Date | null;
  declineReason: string | null; createdAt: Date;
};

function fakeDatabase(options: { products?: boolean } = {}) {
  const events = new Map([
    ["event-general", { id: "event-general", name: "Synthetic Congress", audience: "GENERAL" }],
    ["event-club", { id: "event-club", name: "Synthetic Camporee", audience: "CLUB" }],
  ]);
  const users = new Map([eventAdmin, financeStaff, systemAdmin].map((user) => [user.id, { id: user.id, email: user.email, displayName: user.displayName }]));
  const modules: Array<{ eventId: string; moduleKey: string }> = [];
  const requests: RequestRow[] = [];
  const outbox: Array<Record<string, any>> = [];
  let sequence = 0;
  const empty = { groupBy: vi.fn(async () => []) };
  const tx = {
    event: { findUnique: vi.fn(async ({ where }: any) => events.get(where.id) ?? null) },
    eventModule: {
      findUnique: vi.fn(async ({ where }: any) => modules.find((row) => row.eventId === where.eventId_moduleKey.eventId && row.moduleKey === where.eventId_moduleKey.moduleKey) ?? null),
      createMany: vi.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) if (!modules.some((m) => m.eventId === row.eventId && m.moduleKey === row.moduleKey)) { modules.push(row); count += 1; }
        return { count };
      }),
    },
    moduleRequest: {
      findMany: vi.fn(async ({ where }: any) => requests
        .filter((r) => r.eventId === where.eventId && r.moduleKey === where.moduleKey && r.status === where.status)
        .map((r) => ({ id: r.id, event: { name: events.get(r.eventId)!.name }, requestedBy: users.get(r.requestedByUserId ?? "") ?? null }))),
      findFirst: vi.fn(async ({ where }: any) => requests.find((r) => r.eventId === where.eventId && r.moduleKey === where.moduleKey && r.status === where.status) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row: RequestRow = { id: `req-${++sequence}`, status: "PENDING", decidedByUserId: null, decidedAt: null, declineReason: null, createdAt: new Date(2026, 9, 3, 12, sequence), ...data };
        requests.push(row);
        return { id: row.id };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = requests.find((r) => r.id === where.id && r.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = requests.find((r) => r.id === where.id);
        if (!row) return null;
        return { ...row, event: { name: events.get(row.eventId)!.name }, requestedBy: row.requestedByUserId ? users.get(row.requestedByUserId) ?? null : null };
      }),
    },
    messageOutbox: { create: vi.fn(async ({ data }: any) => { outbox.push(data); return { id: `msg-${outbox.length}` }; }) },
    merchandiseProduct: options.products
      ? { groupBy: vi.fn(async () => [{ eventId: "event-general" }]) }
      : empty,
    programAssignmentRun: empty,
    honorSession: empty,
    honorOffering: empty,
    honorEnrollment: empty,
    $queryRaw: vi.fn(async () => []),
  };
  // The rollback is real enough for these tests: a throw inside restores the rows.
  const prisma = {
    ...tx,
    moduleRequest: {
      ...tx.moduleRequest,
      findMany: vi.fn(async () => requests.filter((r) => r.status === "PENDING").map((r) => ({
        ...r, event: { name: events.get(r.eventId)!.name }, requestedBy: users.get(r.requestedByUserId ?? "") ?? null,
      }))),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
      const snapshot = { modules: modules.map((m) => ({ ...m })), requests: requests.map((r) => ({ ...r })), outbox: [...outbox] };
      try {
        return await callback(tx);
      } catch (error) {
        modules.splice(0, modules.length, ...snapshot.modules);
        requests.splice(0, requests.length, ...snapshot.requests);
        outbox.splice(0, outbox.length, ...snapshot.outbox);
        throw error;
      }
    }),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { modules, requests, outbox };
}

function memberships(map: Record<string, "EVENT_ADMIN" | "FINANCE_MANAGER" | "COMMUNICATIONS_MANAGER" | "READ_ONLY_STAFF">) {
  mocks.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => {
    const role = map[`${userId}:${eventId}`];
    return role ? { eventId, userId, role, status: "ACTIVE", permissions: [] } : null;
  });
}

const grants = { "user-ea:event-general": "EVENT_ADMIN", "user-ea:event-club": "EVENT_ADMIN", "user-fin:event-general": "FINANCE_MANAGER" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  memberships({ ...grants });
  mocks.getPlatformSettings.mockResolvedValue({ supportContact: "office@imsda-events.test" });
  mocks.getAccountEmailSender.mockReturnValue({ name: "IMSDA Events", address: "events@imsda-events.test", replyTo: null });
  mocks.isAccountEmailConfigured.mockReturnValue(false);
});

describe("who may request", () => {
  it("lets an Event Admin of the event ask, queues it, audits it, and emails the conference office", async () => {
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "  We sell shirts at the gate.  ");
    expect(db.requests).toEqual([expect.objectContaining({ id, eventId: "event-general", moduleKey: "merchandise", status: "PENDING", reason: "We sell shirts at the gate.", requestedByUserId: "user-ea" })]);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MODULE_REQUEST_CREATED", entityType: "ModuleRequest", entityId: id, actorUserId: "user-ea", metadata: { eventId: "event-general", moduleKey: "merchandise", requestId: id } }),
      expect.anything(),
    );
    // The local capture: one queued office email, to the configured address only.
    expect(db.outbox).toHaveLength(1);
    expect(db.outbox[0]).toMatchObject({ templateKey: "MODULE_REQUEST_SUBMITTED", recipientKind: "INTERNAL", recipientEmail: "office@imsda-events.test", eventId: null });
    expect(db.outbox[0].subjectSnapshot).toContain("Merchandise");
    expect(db.outbox[0].bodyTextSnapshot).toContain("We sell shirts at the gate.");
    expect(db.outbox[0].bodyTextSnapshot).toContain("https://events.imsda.test/admin#module-requests");
    // Account email is not configured here, so nothing is sent and the row waits.
    expect(mocks.processAccountEmailQueue).not.toHaveBeenCalled();
  });

  it("tries to deliver straight away when account email is configured", async () => {
    mocks.isAccountEmailConfigured.mockReturnValue(true);
    fakeDatabase();
    await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    expect(mocks.processAccountEmailQueue).toHaveBeenCalledWith({ messageIds: ["msg-1"] });
  });

  it.each([
    ["finance staff on the event", financeStaff, 403, "PERMISSION_DENIED"],
    ["a user with no membership", outsider, 403, "EVENT_ACCESS_DENIED"],
  ])("refuses %s", async (_label, actor, status, code) => {
    const db = fakeDatabase();
    await expect(createModuleRequest(actor, "event-general", "merchandise", "Because.")).rejects.toMatchObject({ status, code });
    expect(db.requests).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });

  it("refuses a signed-out caller and an Event Admin of a different event", async () => {
    fakeDatabase();
    await expect(createModuleRequest(null, "event-general", "merchandise", "Because.")).rejects.toBeInstanceOf(AccessDeniedError);
    memberships({ "user-ea:event-club": "EVENT_ADMIN" });
    await expect(createModuleRequest(eventAdmin, "event-general", "merchandise", "Because.")).rejects.toMatchObject({ code: "EVENT_ACCESS_DENIED" });
  });

  it("limits the reason: required, trimmed, and at most 500 characters", async () => {
    const db = fakeDatabase();
    await expect(createModuleRequest(eventAdmin, "event-general", "merchandise", "   ")).rejects.toMatchObject({ code: "INVALID_REASON" });
    await expect(createModuleRequest(eventAdmin, "event-general", "merchandise", "x".repeat(501))).rejects.toMatchObject({ code: "INVALID_REASON" });
    expect(db.requests).toHaveLength(0);
  });

  it("still queues the request when no conference office address is set, with no email", async () => {
    mocks.getPlatformSettings.mockResolvedValue({ supportContact: null });
    const db = fakeDatabase();
    await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    expect(db.requests).toHaveLength(1);
    expect(db.outbox).toHaveLength(0);
  });
});

describe("what is refused", () => {
  it("refuses an unknown module", async () => {
    fakeDatabase();
    await expect(createModuleRequest(eventAdmin, "event-general", "not-a-module", "Because.")).rejects.toMatchObject({ code: "UNKNOWN_MODULE" });
  });

  it("refuses a club module on a general event: it does not apply", async () => {
    const db = fakeDatabase();
    await expect(createModuleRequest(eventAdmin, "event-general", "club-assignments", "Because.")).rejects.toBeInstanceOf(EventModuleError);
    await expect(createModuleRequest(eventAdmin, "event-general", "club-assignments", "Because.")).rejects.toMatchObject({ code: "NOT_APPLICABLE" });
    expect(db.requests).toHaveLength(0);
  });

  it("allows the same club module on a club event", async () => {
    fakeDatabase();
    await expect(createModuleRequest(eventAdmin, "event-club", "club-assignments", "Because.")).resolves.toMatchObject({ id: expect.any(String) });
  });

  it.each([
    ["a module with a stored row", async (db: ReturnType<typeof fakeDatabase>) => { db.modules.push({ eventId: "event-general", moduleKey: "attendee-community" }); }, "attendee-community"],
    ["an always-on module", async () => undefined, "public-content"],
  ])("refuses %s: it is already on", async (_label, arrange, key) => {
    const db = fakeDatabase();
    await arrange(db);
    await expect(createModuleRequest(eventAdmin, "event-general", key, "Because.")).rejects.toMatchObject({ code: "ALREADY_ENABLED" });
    expect(db.requests).toHaveLength(0);
  });

  it("refuses a module the event's own data keeps on (products make Merchandise on)", async () => {
    const db = fakeDatabase({ products: true });
    await expect(createModuleRequest(eventAdmin, "event-general", "merchandise", "Because.")).rejects.toMatchObject({ code: "ALREADY_ENABLED" });
    expect(db.requests).toHaveLength(0);
  });
});

describe("re-request rules", () => {
  it("blocks a second request while one is pending", async () => {
    const db = fakeDatabase();
    await createModuleRequest(eventAdmin, "event-general", "merchandise", "First.");
    await expect(createModuleRequest(eventAdmin, "event-general", "merchandise", "Second.")).rejects.toMatchObject({ code: "ALREADY_PENDING" });
    expect(db.requests).toHaveLength(1);
    expect(db.outbox).toHaveLength(1);
  });

  it("allows another module while one is pending", async () => {
    const db = fakeDatabase();
    await createModuleRequest(eventAdmin, "event-general", "merchandise", "First.");
    await createModuleRequest(eventAdmin, "event-general", "attendee-community", "Second.");
    expect(db.requests).toHaveLength(2);
  });

  it("allows a new request after a decline, keeping the declined one as history", async () => {
    const db = fakeDatabase();
    const first = await createModuleRequest(eventAdmin, "event-general", "merchandise", "First.");
    await decideModuleRequest(systemAdmin, first.id, { decision: "decline", declineReason: "Not this year." });
    const second = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Things changed.");
    expect(second.id).not.toBe(first.id);
    expect(db.requests.map((r) => r.status)).toEqual(["DECLINED", "PENDING"]);
  });

  it("has nothing to request after an approval: the module is on", async () => {
    const db = fakeDatabase();
    const first = await createModuleRequest(eventAdmin, "event-general", "merchandise", "First.");
    await decideModuleRequest(systemAdmin, first.id, { decision: "approve" });
    await expect(createModuleRequest(eventAdmin, "event-general", "merchandise", "Again.")).rejects.toMatchObject({ code: "ALREADY_ENABLED" });
    expect(db.requests).toHaveLength(1);
  });
});

describe("deciding", () => {
  it("approving enables the module, audits both changes with ids and keys only, and emails the requester", async () => {
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Private reason text.");
    mocks.writeAuditLog.mockClear();
    await expect(decideModuleRequest(systemAdmin, id, { decision: "approve" })).resolves.toEqual({ status: "APPROVED" });
    expect(db.modules).toEqual([{ eventId: "event-general", moduleKey: "merchandise" }]);
    expect(db.requests[0]).toMatchObject({ status: "APPROVED", decidedByUserId: "user-admin", decidedAt: expect.any(Date), declineReason: null });
    const audits = mocks.writeAuditLog.mock.calls.map(([entry]) => entry);
    expect(audits.map((entry) => entry.action)).toEqual(["EVENT_MODULE_ENABLED", "MODULE_REQUEST_APPROVED"]);
    expect(audits[1].metadata).toEqual({ eventId: "event-general", moduleKey: "merchandise", requestId: id });
    expect(JSON.stringify(audits)).not.toContain("Private reason text.");
    const email = db.outbox.at(-1)!;
    expect(email).toMatchObject({ templateKey: "MODULE_REQUEST_DECIDED", recipientKind: "ACCOUNT", recipientEmail: "ea@imsda-events.test", accountUserId: "user-ea" });
    expect(email.subjectSnapshot).toContain("Merchandise is now on");
  });

  it("declining needs a reason, keeps the module off, audits without the reason, and emails the requester with it", async () => {
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    await expect(decideModuleRequest(systemAdmin, id, { decision: "decline", declineReason: "   " })).rejects.toMatchObject({ code: "INVALID_REASON" });
    expect(db.requests[0].status).toBe("PENDING");
    mocks.writeAuditLog.mockClear();
    await decideModuleRequest(systemAdmin, id, { decision: "decline", declineReason: "Use the shop partner." });
    expect(db.modules).toHaveLength(0);
    expect(db.requests[0]).toMatchObject({ status: "DECLINED", declineReason: "Use the shop partner." });
    const [audit] = mocks.writeAuditLog.mock.calls.map(([entry]) => entry);
    expect(audit).toMatchObject({ action: "MODULE_REQUEST_DECLINED", metadata: { eventId: "event-general", moduleKey: "merchandise", requestId: id } });
    expect(JSON.stringify(audit)).not.toContain("Use the shop partner.");
    const email = db.outbox.at(-1)!;
    expect(email.subjectSnapshot).toContain("declined");
    expect(email.bodyTextSnapshot).toContain("Use the shop partner.");
    expect(email.recipientEmail).toBe("ea@imsda-events.test");
  });

  it.each([
    ["an Event Admin", eventAdmin],
    ["finance staff", financeStaff],
    ["a signed-out caller", null],
  ])("refuses %s deciding", async (_label, actor) => {
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    await expect(decideModuleRequest(actor, id, { decision: "approve" })).rejects.toBeInstanceOf(AccessDeniedError);
    expect(db.requests[0].status).toBe("PENDING");
    expect(db.modules).toHaveLength(0);
  });

  it("decides a request once: a second decision is refused and a missing id is not found", async () => {
    fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    await decideModuleRequest(systemAdmin, id, { decision: "approve" });
    await expect(decideModuleRequest(systemAdmin, id, { decision: "decline", declineReason: "Late." })).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(decideModuleRequest(systemAdmin, "req-missing", { decision: "approve" })).rejects.toBeInstanceOf(ModuleRequestError);
    await expect(decideModuleRequest(systemAdmin, "req-missing", { decision: "approve" })).rejects.toMatchObject({ code: "REQUEST_NOT_FOUND" });
  });

  it("leaves the request pending when the module cannot be enabled any more (the event type changed)", async () => {
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-club", "club-assignments", "Assign campsites.");
    // The event was switched to a general event before the decision.
    (await (mocks.getPrisma() as any).event.findUnique({ where: { id: "event-club" } })).audience = "GENERAL";
    await expect(decideModuleRequest(systemAdmin, id, { decision: "approve" })).rejects.toMatchObject({ code: "NOT_APPLICABLE" });
    expect(db.requests[0].status).toBe("PENDING");
    expect(db.modules).toHaveLength(0);
  });
});

describe("the System management queue", () => {
  it("lists pending requests with event, module and requester", async () => {
    fakeDatabase();
    await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    const queue = await listPendingModuleRequests();
    expect(queue).toEqual([expect.objectContaining({ eventName: "Synthetic Congress", moduleTitle: "Merchandise", requesterName: "Eli EventAdmin", reason: "Shirts." })]);
  });
});

describe("system administrators", () => {
  it("cannot request: refused with a clear code (the route answers 403), nothing queued", async () => {
    const db = fakeDatabase();
    await expect(createModuleRequest(systemAdmin, "event-general", "merchandise", "Because.")).rejects.toMatchObject({ code: "SYSTEM_ADMIN_ENABLES_DIRECTLY" });
    expect(db.requests).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });

  it("answer a pending request by turning the module on directly: approved by them, audited, requester emailed", async () => {
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Shirts.");
    mocks.writeAuditLog.mockClear();
    await enableModule(systemAdmin, "event-general", "merchandise");
    expect(db.modules).toEqual([{ eventId: "event-general", moduleKey: "merchandise" }]);
    expect(db.requests[0]).toMatchObject({ id, status: "APPROVED", decidedByUserId: "user-admin", decidedAt: expect.any(Date) });
    const audits = mocks.writeAuditLog.mock.calls.map(([entry]) => entry);
    expect(audits.map((entry) => entry.action)).toEqual(["MODULE_REQUEST_APPROVED", "EVENT_MODULE_ENABLED"]);
    expect(audits[0].metadata).toEqual({ eventId: "event-general", moduleKey: "merchandise", requestId: id });
    expect(db.outbox.at(-1)).toMatchObject({ templateKey: "MODULE_REQUEST_DECIDED", recipientEmail: "ea@imsda-events.test" });
    expect(db.outbox.at(-1)!.subjectSnapshot).toContain("Merchandise is now on");
  });

  it("enabling with no pending request changes no request and sends no email", async () => {
    const db = fakeDatabase();
    await enableModule(systemAdmin, "event-general", "merchandise");
    expect(db.requests).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });
});

describe("free text in emails", () => {
  it("breaks up {{ and }} in the reason, event name and decline reason", async () => {
    expect(neutralizePlaceholders("a {{account_action_link}} b")).toBe("a { {account_action_link} } b");
    const db = fakeDatabase();
    const { id } = await createModuleRequest(eventAdmin, "event-general", "merchandise", "Click {{account_action_link}} now");
    expect(db.outbox[0].bodyTextSnapshot).not.toContain("{{");
    expect(db.outbox[0].bodyTextSnapshot).toContain("{ {account_action_link} }");
    await decideModuleRequest(systemAdmin, id, { decision: "decline", declineReason: "No {{account_action_link}}" });
    expect(db.outbox.at(-1)!.bodyTextSnapshot).not.toContain("{{");
    expect(db.outbox.at(-1)!.bodyTextSnapshot).toContain("No { {account_action_link} }");
  });
});
