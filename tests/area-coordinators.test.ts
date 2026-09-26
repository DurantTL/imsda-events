import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  grantFindUnique: vi.fn(),
  grantUpsert: vi.fn(),
  grantUpdateMany: vi.fn(),
  accountFindUnique: vi.fn(),
  writeAuditLog: vi.fn(),
  getCurrentAttendee: vi.fn(),
  findSwitchable: vi.fn(),
  orgFindUnique: vi.fn(),
  grantFindFirst: vi.fn(),
  grantCreate: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  getCurrentSession: vi.fn(),
}));

const client = {
  areaCoordinatorGrant: { findUnique: mocks.grantFindUnique, upsert: mocks.grantUpsert, updateMany: mocks.grantUpdateMany },
  attendeeAccount: { findUnique: mocks.accountFindUnique },
  organization: { findUnique: mocks.orgFindUnique },
  clubDirectorGrant: { findFirst: mocks.grantFindFirst, create: mocks.grantCreate },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee, findSwitchableAttendeeAccountForStaff: mocks.findSwitchable }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));

import { POST as ACCOUNT_ACTION } from "@/app/api/admin/accounts/[accountId]/route";
import { currentAreaCoordinator, setAreaCoordinator } from "@/modules/organizations/area-coordinators";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountFindUnique.mockResolvedValue({ id: "account-1" });
  mocks.grantFindUnique.mockResolvedValue({ revokedAt: null });
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "session-1" });
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.findSwitchable.mockResolvedValue({ id: "admin-account" });
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Test Pathfinders" });
  mocks.grantFindFirst.mockResolvedValue(null);
  mocks.grantCreate.mockResolvedValue({ id: "grant-1" });
});

describe("Area Coordinators (#387)", () => {
  it("only counts a signed-in coordinator who has passed the second step", async () => {
    await expect(currentAreaCoordinator()).resolves.toEqual({ id: "account-1" });

    mocks.accountNeedsSecondStep.mockResolvedValueOnce("VERIFY");
    await expect(currentAreaCoordinator()).resolves.toBeNull();

    mocks.grantFindUnique.mockResolvedValueOnce({ revokedAt: new Date() });
    await expect(currentAreaCoordinator()).resolves.toBeNull();

    mocks.getCurrentAttendee.mockResolvedValueOnce({ account: { id: "account-1" }, via: "staff", sessionId: null });
    await expect(currentAreaCoordinator()).resolves.toBeNull();
  });

  it("grants and removes the role, audited without names", async () => {
    await setAreaCoordinator("account-1", true, "admin-1");
    expect(mocks.grantUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { attendeeAccountId: "account-1" },
      update: expect.objectContaining({ revokedAt: null, grantedByUserId: "admin-1" }),
    }));
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "AREA_COORDINATOR_GRANTED", actorUserId: "admin-1", entityId: "account-1" });

    await setAreaCoordinator("account-1", false, "admin-1");
    expect(mocks.grantUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { attendeeAccountId: "account-1", revokedAt: null },
      data: expect.objectContaining({ revokedByUserId: "admin-1" }),
    }));
    expect(mocks.writeAuditLog.mock.calls[1]![0]).toMatchObject({ action: "AREA_COORDINATOR_REVOKED" });
  });

  it("refuses an unknown account", async () => {
    mocks.accountFindUnique.mockResolvedValue(null);
    await expect(setAreaCoordinator("nobody", true, "admin-1")).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("answers 404, not 500, when the account to make an Area Coordinator doesn't exist", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" }, sessionId: "staff-session-1" });
    mocks.accountFindUnique.mockResolvedValue(null);
    const response = await ACCOUNT_ACTION(new Request("https://events.imsda.test/api/admin/accounts/nobody", {
      method: "POST",
      headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
      body: JSON.stringify({ action: "area-coordinator", on: true }),
    }), { params: Promise.resolve({ accountId: "nobody" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "ACCOUNT_NOT_FOUND" });
  });

  it("stops counting a temporary role once it ends", async () => {
    mocks.grantFindUnique.mockResolvedValueOnce({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
    await expect(currentAreaCoordinator()).resolves.toBeNull();
  });

  // Staff "act as" (#442) moved to modules/organizations/staff-act-as.ts,
  // tied to the staff session instead of the staff member's own attendee
  // account — see tests/staff-act-as.test.ts.
});
