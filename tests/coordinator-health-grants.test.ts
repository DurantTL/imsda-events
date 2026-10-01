import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  setHealthAccess: vi.fn(),
  writeAuditLog: vi.fn(),
  membershipFindFirst: vi.fn(),
  membershipUpdate: vi.fn(),
  sessionUpdateMany: vi.fn(),
}));

const client = {
  eventMembership: { findFirst: mocks.membershipFindFirst, update: mocks.membershipUpdate },
  userSession: { updateMany: mocks.sessionUpdateMany },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { PUT } from "@/app/api/events/[eventId]/memberships/[membershipId]/health-access/route";
import * as grants from "@/modules/coordinator-health/membership-grants";

const params = { params: Promise.resolve({ eventId: "e1", membershipId: "m1" }) };
const put = (body: unknown) => new Request("https://events.imsda.test/api/events/e1/memberships/m1/health-access", { method: "PUT", body: JSON.stringify(body) });

describe("granting health information access (#658)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
  });

  it("is refused for a signed-out caller", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    const response = await PUT(put({ granted: true }), params);
    expect(response.status).toBe(401);
  });

  it.each(["Event Admin", "Registration Manager", "read-only staff"])("is refused for %s: only a system administrator can grant it", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u1", globalRole: null } });
    const response = await PUT(put({ granted: true }), params);
    expect(response.status).toBe(403);
    expect(mocks.membershipUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "root", globalRole: "SYSTEM_ADMIN" } });
    expect((await PUT(put({ granted: "yes" }), params)).status).toBe(400);
  });

  it("lets a system administrator grant and revoke, each audited without health text", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "root", globalRole: "SYSTEM_ADMIN" } });
    mocks.membershipFindFirst.mockResolvedValue({ id: "m1", userId: "u9", permissions: ["MANAGE_FORMS"], user: { displayName: "Synthetic Staffer" } });
    const granted = await PUT(put({ granted: true }), params);
    expect(granted.status).toBe(200);
    expect(mocks.membershipUpdate).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION"] } });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ eventId: "e1", actorUserId: "root", action: "HEALTH_ACCESS_GRANTED", entityType: "EventMembership", entityId: "m1" });

    mocks.membershipFindFirst.mockResolvedValue({ id: "m1", userId: "u9", permissions: ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION"], user: { displayName: "Synthetic Staffer" } });
    await PUT(put({ granted: false }), params);
    expect(mocks.membershipUpdate).toHaveBeenLastCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS"] } });
    expect(mocks.writeAuditLog.mock.calls[1][0]).toMatchObject({ action: "HEALTH_ACCESS_REVOKED" });
  });

  it("ends all of the user's sessions on a grant and on a revoke, so the next sign-in passes two-step", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "root", globalRole: "SYSTEM_ADMIN" } });
    mocks.membershipFindFirst.mockResolvedValue({ id: "m1", userId: "u9", permissions: [], user: { displayName: "Synthetic Staffer" } });
    await PUT(put({ granted: true }), params);
    expect(mocks.sessionUpdateMany).toHaveBeenLastCalledWith({ where: { userId: "u9", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    mocks.membershipFindFirst.mockResolvedValue({ id: "m1", userId: "u9", permissions: ["VIEW_HEALTH_INFORMATION"], user: { displayName: "Synthetic Staffer" } });
    await PUT(put({ granted: false }), params);
    expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.sessionUpdateMany).toHaveBeenLastCalledWith({ where: { userId: "u9", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it("ends no sessions when nothing changed", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ id: "m1", userId: "u9", permissions: [], user: { displayName: "Synthetic Staffer" } });
    await grants.setHealthAccess("e1", "m1", "root", false);
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it("answers 400, not 500, for a body that is not JSON", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "root", globalRole: "SYSTEM_ADMIN" } });
    const response = await PUT(new Request("https://events.imsda.test/x", { method: "PUT", body: "{nope" }), params);
    expect(response.status).toBe(400);
  });

  it("writes nothing when the state is unchanged", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ id: "m1", userId: "u9", permissions: [], user: { displayName: "Synthetic Staffer" } });
    expect(await grants.setHealthAccess("e1", "m1", "root", false)).toEqual({ granted: false, changed: false });
    expect(mocks.membershipUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("answers 404 for a membership of another event", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "root", globalRole: "SYSTEM_ADMIN" } });
    mocks.membershipFindFirst.mockResolvedValue(null);
    expect((await PUT(put({ granted: true }), params)).status).toBe(404);
  });
});
