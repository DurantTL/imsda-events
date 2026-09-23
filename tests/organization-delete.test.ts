import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  orgFindMany: vi.fn(),
  orgDeleteMany: vi.fn(),
  rosterDeleteMany: vi.fn(),
  grantDeleteMany: vi.fn(),
  writeAuditLog: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.orgFindUnique, findMany: mocks.orgFindMany, deleteMany: mocks.orgDeleteMany },
  clubRosterMember: { deleteMany: mocks.rosterDeleteMany },
  clubDirectorGrant: { deleteMany: mocks.grantDeleteMany },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { DELETE } from "@/app/api/admin/organizations/[organizationId]/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { deleteOrganization, getOrganizationDeletionCheck } from "@/modules/organizations/repository";

function counts(overrides: Record<string, number> = {}) {
  return {
    childOrganizations: 0,
    eventRegistrations: 0,
    honorEnrollments: 0,
    rosterMembers: 12,
    directorGrants: 2,
    clubInvites: 1,
    monthlyReports: 3,
    externalIdentities: 0,
    ...overrides,
  };
}

function club(overrides: Record<string, number> = {}) {
  return { id: "club-1", type: "CLUB", name: "Test Pathfinders", _count: counts(overrides) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgFindUnique.mockResolvedValue(club());
  mocks.orgFindMany.mockResolvedValue([]);
  mocks.orgDeleteMany.mockResolvedValue({ count: 1 });
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
});

describe("deleting churches and clubs (#386)", () => {
  it("reports what a club deletion removes", async () => {
    const check = await getOrganizationDeletionCheck("club-1");
    expect(check.blockers).toEqual([]);
    expect(check.removes).toEqual({ rosterMembers: 12, clubRoles: 2, invites: 1, monthlyReports: 3, providerIdentifiers: 0 });
  });

  it("keeps a church that still has clubs, and a club with event registrations or honor enrollments", async () => {
    mocks.orgFindUnique.mockResolvedValueOnce({ id: "church-1", type: "CHURCH", name: "Test Church", _count: counts({ childOrganizations: 2 }) });
    expect((await getOrganizationDeletionCheck("church-1")).blockers[0]).toMatch(/2 clubs are listed under this church/);
    mocks.orgFindUnique.mockResolvedValueOnce(club({ eventRegistrations: 1, honorEnrollments: 4 }));
    const check = await getOrganizationDeletionCheck("club-1");
    expect(check.blockers).toHaveLength(2);
    expect(check.blockers[0]).toMatch(/deactivate the club instead/);

    mocks.orgFindUnique.mockResolvedValueOnce(club({ eventRegistrations: 1 }));
    await expect(deleteOrganization("club-1", "Test Pathfinders", "admin-1")).rejects.toMatchObject({ code: "ORGANIZATION_DELETE_BLOCKED" });
    expect(mocks.orgDeleteMany).not.toHaveBeenCalled();
  });

  it("needs the name typed exactly", async () => {
    await expect(deleteOrganization("club-1", "Test", "admin-1")).rejects.toMatchObject({ code: "ORGANIZATION_DELETE_NAME_MISMATCH" });
    expect(mocks.rosterDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes the roster and club roles with the club, and audits counts only", async () => {
    await deleteOrganization("club-1", "  Test Pathfinders ", "admin-1");
    expect(mocks.rosterDeleteMany).toHaveBeenCalledWith({ where: { organizationId: "club-1" } });
    expect(mocks.grantDeleteMany).toHaveBeenCalledWith({ where: { organizationId: "club-1" } });
    expect(mocks.orgDeleteMany).toHaveBeenCalledWith({ where: { id: "club-1" } });
    const audit = mocks.writeAuditLog.mock.calls[0]![0];
    expect(audit).toMatchObject({ action: "ORGANIZATION_DELETED", actorUserId: "admin-1", entityId: "club-1" });
    expect(JSON.stringify(audit)).not.toContain("Test Pathfinders");
  });

  it("the route requires a system administrator and maps a wrong name to 400", async () => {
    const request = () => new Request("http://localhost/api/admin/organizations/club-1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: "Wrong" }),
    });
    const context = { params: Promise.resolve({ organizationId: "club-1" }) };
    expect((await DELETE(request(), context)).status).toBe(400);

    mocks.requireSystemAdministrator.mockRejectedValueOnce(new AccessDeniedError("No", 403, "PERMISSION_DENIED"));
    expect((await DELETE(request(), context)).status).toBe(403);
    expect(mocks.orgDeleteMany).not.toHaveBeenCalled();
  });
});
