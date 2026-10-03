import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 3 against a real PostgreSQL: the migration's partial unique index
 * and a concurrent double submit leaving exactly one pending request, then an
 * approve and a decline end to end. Runs only when
 * `MODULE_REQUESTS_TEST_DATABASE_URL` names a database with every migration
 * applied (a throwaway one: the test writes synthetic rows and removes them);
 * the default suite skips it. Synthetic data only.
 */
const databaseUrl = process.env.MODULE_REQUESTS_TEST_DATABASE_URL;

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ prisma: null as unknown, processAccountEmailQueue: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => mocks.prisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/system-admin/platform-settings", () => ({ getPlatformSettings: async () => ({ supportContact: "office@imsda-events.test" }) }));
vi.mock("@/modules/communications/account-email", () => ({
  AccountEmailNotConfiguredError: class extends Error {},
  getAccountEmailSender: () => ({ name: "IMSDA Events", address: "events@imsda-events.test", replyTo: null }),
  isAccountEmailConfigured: () => false,
}));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: mocks.processAccountEmailQueue }));

import type { AuthenticatedUser } from "@/modules/access/authorization";
import { createModuleRequest, decideModuleRequest } from "@/modules/event-modules/requests";

describe.skipIf(!databaseUrl)("module requests on PostgreSQL (#741 slice 3)", () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const tag = randomUUID().slice(0, 8);
  const ids = { event: `ev-${tag}`, club: `ev-club-${tag}`, admin: `u-admin-${tag}`, requester: `u-req-${tag}` };
  const admin = { id: ids.admin, email: `admin-${tag}@imsda-events.test`, displayName: "Alex Admin", globalRole: "SYSTEM_ADMIN" } as AuthenticatedUser;
  const requester = { id: ids.requester, email: `req-${tag}@imsda-events.test`, displayName: "Eli EventAdmin", globalRole: null } as AuthenticatedUser;

  beforeAll(async () => {
    mocks.prisma = prisma;
    await prisma.user.createMany({ data: [
      { id: ids.admin, email: admin.email, displayName: admin.displayName, globalRole: "SYSTEM_ADMIN" },
      { id: ids.requester, email: requester.email, displayName: requester.displayName },
    ] });
    const when = { startsAt: new Date("2027-07-01T00:00:00Z"), endsAt: new Date("2027-07-03T00:00:00Z") };
    await prisma.event.create({ data: { id: ids.event, slug: `slug-${tag}`, name: "Synthetic Congress", audience: "GENERAL", ...when } });
    await prisma.event.create({ data: { id: ids.club, slug: `slug-club-${tag}`, name: "Synthetic Camporee", audience: "CLUB", ...when } });
    await prisma.eventMembership.createMany({ data: [
      { eventId: ids.event, userId: ids.requester, role: "EVENT_ADMIN" },
      { eventId: ids.club, userId: ids.requester, role: "EVENT_ADMIN" },
    ] });
  });

  afterAll(async () => {
    await prisma.messageOutbox.deleteMany({ where: { OR: [{ accountUserId: ids.requester }, { recipientEmail: "office@imsda-events.test" }] } });
    await prisma.auditLog.deleteMany({ where: { eventId: { in: [ids.event, ids.club] } } });
    await prisma.event.deleteMany({ where: { id: { in: [ids.event, ids.club] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.requester] } } });
    await prisma.$disconnect();
  });

  it("the database allows one pending request per event and module, and any number of decided ones", async () => {
    const base = { eventId: ids.event, moduleKey: "attendee-community", reason: "Because." };
    const first = await prisma.moduleRequest.create({ data: base });
    await expect(prisma.moduleRequest.create({ data: base })).rejects.toMatchObject({ code: "P2002" });
    // A different module, and a different event, are separate.
    await prisma.moduleRequest.create({ data: { ...base, moduleKey: "merchandise" } });
    await prisma.moduleRequest.create({ data: { ...base, eventId: ids.club } });
    // Decided requests do not count: decline the first, then a new pending one is fine, twice over as history.
    await prisma.moduleRequest.update({ where: { id: first.id }, data: { status: "DECLINED", declineReason: "No." } });
    const second = await prisma.moduleRequest.create({ data: base });
    await prisma.moduleRequest.update({ where: { id: second.id }, data: { status: "DECLINED", declineReason: "No." } });
    await prisma.moduleRequest.create({ data: base });
    const rows = await prisma.moduleRequest.findMany({ where: { eventId: ids.event, moduleKey: "attendee-community" } });
    expect(rows.map((row) => row.status).sort()).toEqual(["DECLINED", "DECLINED", "PENDING"]);
    await prisma.moduleRequest.deleteMany({ where: { eventId: { in: [ids.event, ids.club] } } });
  });

  it("a concurrent double submit leaves exactly one pending request and one office email", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => createModuleRequest(requester, ids.event, "merchandise", `Shirts ${index}.`)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "ALREADY_PENDING" });
    }
    const pending = await prisma.moduleRequest.findMany({ where: { eventId: ids.event, moduleKey: "merchandise", status: "PENDING" } });
    expect(pending).toHaveLength(1);
    // The losers' transactions rolled back with their audit entries and emails.
    expect(await prisma.auditLog.count({ where: { eventId: ids.event, action: "MODULE_REQUEST_CREATED" } })).toBe(1);
    const queued = await prisma.messageOutbox.findMany({ where: { templateKey: "MODULE_REQUEST_SUBMITTED", idempotencyKey: { contains: pending[0].id } } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ recipientEmail: "office@imsda-events.test", status: "PENDING" });
  });

  it("approving enables the module in the same transaction, audits it, and queues the requester's email", async () => {
    const pending = await prisma.moduleRequest.findFirstOrThrow({ where: { eventId: ids.event, moduleKey: "merchandise", status: "PENDING" } });
    await expect(decideModuleRequest(admin, pending.id, { decision: "approve" })).resolves.toEqual({ status: "APPROVED" });
    expect(await prisma.eventModule.count({ where: { eventId: ids.event, moduleKey: "merchandise" } })).toBe(1);
    const actions = (await prisma.auditLog.findMany({ where: { eventId: ids.event }, select: { action: true, metadata: true } })).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["EVENT_MODULE_ENABLED", "MODULE_REQUEST_APPROVED"]));
    const email = await prisma.messageOutbox.findUniqueOrThrow({ where: { idempotencyKey: `module-request:${pending.id}:decided` } });
    expect(email).toMatchObject({ templateKey: "MODULE_REQUEST_DECIDED", recipientEmail: requester.email, accountUserId: ids.requester });
    // The module is on now: nothing to request.
    await expect(createModuleRequest(requester, ids.event, "merchandise", "Again.")).rejects.toMatchObject({ code: "ALREADY_ENABLED" });
  });

  it("two system administrators deciding at once: one wins and the request is decided once", async () => {
    const { id } = await createModuleRequest(requester, ids.event, "attendee-community", "Discussion.");
    const results = await Promise.allSettled([
      decideModuleRequest(admin, id, { decision: "approve" }),
      decideModuleRequest(admin, id, { decision: "decline", declineReason: "No." }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const request = await prisma.moduleRequest.findUniqueOrThrow({ where: { id } });
    expect(request.status).not.toBe("PENDING");
    expect(await prisma.messageOutbox.count({ where: { idempotencyKey: `module-request:${id}:decided` } })).toBe(1);
  });

  it("declining keeps the module off and the request can be made again", async () => {
    const { id } = await createModuleRequest(requester, ids.club, "club-assignments", "Campsites.");
    await decideModuleRequest(admin, id, { decision: "decline", declineReason: "Next year." });
    expect(await prisma.eventModule.count({ where: { eventId: ids.club, moduleKey: "club-assignments" } })).toBe(0);
    const declineAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId: ids.club, action: "MODULE_REQUEST_DECLINED" } });
    expect(JSON.stringify(declineAudit.metadata)).not.toContain("Next year.");
    await expect(createModuleRequest(requester, ids.club, "club-assignments", "Again.")).resolves.toMatchObject({ id: expect.any(String) });
  });
});
