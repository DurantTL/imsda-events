import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staff "act as" routes (#442) through the real origin check, the real
 * system-administrator check, and the real act-as module: only the staff
 * session, the database, and the audit writer are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  getServerEnv: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  revokeDatabaseSession: vi.fn(),
  writeAuditLog: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  orgFindUnique: vi.fn(),
}));

const client = {
  staffActAs: { findFirst: mocks.findFirst, updateMany: mocks.updateMany, create: mocks.create },
  organization: { findUnique: mocks.orgFindUnique },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: mocks.cookieGet, set: mocks.cookieSet })) }));
vi.mock("@/lib/env", () => ({ getServerEnv: mocks.getServerEnv, isServerEnvironmentError: () => false }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/session-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/access/session-store")>()),
  revokeDatabaseSession: mocks.revokeDatabaseSession,
}));

import { Prisma } from "@prisma/client";
import { POST as startAreaCoordinator } from "@/app/api/admin/act-as/area-coordinator/route";
import { POST as stopActing } from "@/app/api/admin/act-as/stop/route";
import { POST as startDirector } from "@/app/api/admin/organizations/[organizationId]/act-as-director/route";
import { POST as logout } from "@/app/api/auth/logout/route";

const origin = "https://events.imsda.test";
const admin = { user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" }, sessionId: "staff-session-1" };
const staff = { user: { id: "staff-1", email: "staff@example.test", displayName: "Staff", globalRole: null }, sessionId: "staff-session-2" };

function post(path: string, from = origin) {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin: from } });
}
const directorContext = { params: Promise.resolve({ organizationId: "club-1" }) };

const routes: Array<[string, () => Promise<Response>, (from?: string) => Promise<Response>]> = [
  ["start acting as an Area Coordinator", () => startAreaCoordinator(post("/api/admin/act-as/area-coordinator")), (from) => startAreaCoordinator(post("/api/admin/act-as/area-coordinator", from))],
  ["start acting as a club director", () => startDirector(post("/api/admin/organizations/club-1/act-as-director"), directorContext), (from) => startDirector(post("/api/admin/organizations/club-1/act-as-director", from), directorContext)],
  ["stop acting", () => stopActing(post("/api/admin/act-as/stop")), (from) => stopActing(post("/api/admin/act-as/stop", from))],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerEnv.mockReturnValue({ APP_BASE_URL: origin });
  mocks.getCurrentSession.mockResolvedValue(admin);
  mocks.findFirst.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.create.mockResolvedValue({ id: "act-1" });
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Test Pathfinders" });
  mocks.cookieGet.mockReturnValue({ value: "staff-token" });
});

describe.each(routes)("%s (#442)", (_name, call, callFrom) => {
  it("needs a staff session (401)", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    const response = await call();
    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("is for system administrators only (403)", async () => {
    mocks.getCurrentSession.mockResolvedValue(staff);
    const response = await call();
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request before touching the session", async () => {
    const response = await callFrom("https://attacker.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST_ORIGIN" });
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
  });
});

describe("act-as routes for a system administrator (#442)", () => {
  it("starts acting as a club director and stops again", async () => {
    const started = await routes[1][1]();
    expect(started.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR", organizationId: "club-1" }),
    }));

    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", role: "CLUB_DIRECTOR", organizationId: "club-1" });
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    const stopped = await routes[2][1]();
    expect(await stopped.json()).toEqual({ ok: true, stopped: true });
    expect(mocks.updateMany).toHaveBeenLastCalledWith({ where: { id: "act-1", endedAt: null }, data: expect.objectContaining({ endedReason: "STOPPED" }) });
  });

  it("answers 409, not 500, when two starts on one session keep racing (P2002)", async () => {
    const unique = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    mocks.create.mockRejectedValueOnce(unique()).mockRejectedValueOnce(unique());
    const response = await routes[0][1]();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "ACT_AS_CONFLICT" });
  });

  it("answers 404 for a missing or inactive club", async () => {
    mocks.orgFindUnique.mockResolvedValueOnce(null);
    expect((await routes[1][1]()).status).toBe(404);
  });
});

describe("signing out (#442)", () => {
  it("ends the staff session's active act-as, then revokes the session", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", userId: "admin-1", role: "CLUB_DIRECTOR", organizationId: "club-1" });
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    const response = await logout(post("/api/auth/logout"));
    expect(response.status).toBe(200);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { staffSessionId: "staff-session-1", endedAt: null } }));
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "act-1", endedAt: null }, data: expect.objectContaining({ endedReason: "SIGNED_OUT" }) });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "ACT_AS_STOPPED", actorUserId: "admin-1" }), client);
    expect(mocks.revokeDatabaseSession).toHaveBeenCalledWith("staff-token");
  });

  it("still signs out when ending the act-as fails", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", userId: "admin-1", role: "AREA_COORDINATOR", organizationId: null });
    mocks.updateMany.mockRejectedValueOnce(new Error("database hiccup"));
    const response = await logout(post("/api/auth/logout"));
    expect(response.status).toBe(200);
    expect(mocks.revokeDatabaseSession).toHaveBeenCalled();
  });
});
