import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  sessionUpdateMany: vi.fn(),
  findMany: vi.fn(),
}));

const client = {
  eventMembership: { findFirst: mocks.findFirst, findUnique: mocks.findUnique, count: mocks.count, update: mocks.update, create: mocks.create, findMany: mocks.findMany },
  user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
  userSession: { updateMany: mocks.sessionUpdateMany },
  // The row lock (#167) returns the permissions of the membership the test loaded.
  $queryRaw: async () => {
    const loaded = [...mocks.findFirst.mock.results, ...mocks.findUnique.mock.results];
    for (const result of loaded.reverse()) {
      const row = await result.value;
      if (row?.permissions) return [{ permissions: row.permissions }];
    }
    return [{ permissions: [] }];
  },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { addStaffMembership, updateStaffMembership } from "@/modules/access/membership-repository";

const withHealth = (status: "ACTIVE" | "INACTIVE" = "ACTIVE", role = "READ_ONLY_STAFF") => ({
  id: "m1", eventId: "e1", userId: "u9", role, status, permissions: ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION"],
  user: { displayName: "Synthetic Staffer", email: "staffer@example.test" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(1);
  mocks.update.mockResolvedValue({ role: "READ_ONLY_STAFF", status: "ACTIVE" });
  mocks.findMany.mockResolvedValue([]);
});

describe("health information access does not survive staff changes (#658)", () => {
  it("removes it when a membership is deactivated, ends the sessions, and audits the revoke", async () => {
    mocks.findFirst.mockResolvedValue(withHealth());
    await updateStaffMembership("e1", "m1", "admin-1", { role: "READ_ONLY_STAFF", status: "INACTIVE" }).catch(() => undefined);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS"] } });
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({ where: { userId: "u9", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.writeAuditLog.mock.calls.map(([entry]) => entry.action)).toContain("HEALTH_ACCESS_REVOKED");
  });

  it("an Event Admin who deactivates then reactivates a membership does not bring the access back", async () => {
    // Step 1: deactivate. The stored permissions lose the grant.
    let stored = withHealth();
    mocks.findFirst.mockImplementation(async () => ({ ...stored }));
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...stored, ...data } as typeof stored;
      return stored;
    });
    await updateStaffMembership("e1", "m1", "event-admin", { role: "READ_ONLY_STAFF", status: "INACTIVE" }).catch(() => undefined);
    expect(stored.permissions).not.toContain("VIEW_HEALTH_INFORMATION");
    // Step 2: reactivate through the same PATCH path.
    await updateStaffMembership("e1", "m1", "event-admin", { role: "READ_ONLY_STAFF", status: "ACTIVE" }).catch(() => undefined);
    expect(stored.status).toBe("ACTIVE");
    expect(stored.permissions).toEqual(["MANAGE_FORMS"]);
  });

  it("removes a grant that is still on an inactive membership when it is reactivated", async () => {
    mocks.findFirst.mockResolvedValue(withHealth("INACTIVE"));
    await updateStaffMembership("e1", "m1", "admin-1", { role: "READ_ONLY_STAFF", status: "ACTIVE" }).catch(() => undefined);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS"] } });
  });

  it("removes it on a role change", async () => {
    mocks.findFirst.mockResolvedValue(withHealth("ACTIVE", "READ_ONLY_STAFF"));
    await updateStaffMembership("e1", "m1", "admin-1", { role: "EVENT_ADMIN", status: "ACTIVE" }).catch(() => undefined);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS"] } });
  });

  it("leaves a membership without the grant alone, and an unrelated edit keeps other permissions", async () => {
    mocks.findFirst.mockResolvedValue({ ...withHealth(), permissions: ["MANAGE_FORMS"] });
    await updateStaffMembership("e1", "m1", "admin-1", { role: "READ_ONLY_STAFF", status: "ACTIVE" }).catch(() => undefined);
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog.mock.calls.map(([entry]) => entry.action)).not.toContain("HEALTH_ACCESS_REVOKED");
  });

  it("removes it when the same email is added again", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "u9", credential: { id: "c1" } });
    mocks.findUnique.mockResolvedValue({ ...withHealth("INACTIVE") });
    await addStaffMembership("e1", "event-admin", { email: "staffer@example.test", displayName: "Synthetic Staffer", role: "READ_ONLY_STAFF" }).catch(() => undefined);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS"] } });
    expect(mocks.writeAuditLog.mock.calls.map(([entry]) => entry.action)).toContain("HEALTH_ACCESS_REVOKED");
  });
});
