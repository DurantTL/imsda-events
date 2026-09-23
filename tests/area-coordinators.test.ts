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

import { actAsAreaCoordinator, actAsClubDirector, currentAreaCoordinator, setAreaCoordinator } from "@/modules/organizations/area-coordinators";

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

  it("stops counting a temporary role once it ends", async () => {
    mocks.grantFindUnique.mockResolvedValueOnce({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
    await expect(currentAreaCoordinator()).resolves.toBeNull();
  });

  it("lets a system administrator act as an Area Coordinator on their own account for two hours", async () => {
    const now = new Date("2026-09-23T12:00:00Z");
    mocks.grantFindUnique.mockResolvedValue(null);
    await expect(actAsAreaCoordinator({ id: "admin-1", email: "admin@example.test" }, now))
      .resolves.toEqual({ expiresAt: new Date("2026-09-23T14:00:00Z") });
    expect(mocks.grantUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { attendeeAccountId: "admin-account" } }));
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_AREA_COORDINATOR", actorUserId: "admin-1" });

    mocks.findSwitchable.mockResolvedValueOnce(null);
    await expect(actAsAreaCoordinator({ id: "admin-1", email: "admin@example.test" }, now)).rejects.toMatchObject({ code: "NO_OWN_ACCOUNT" });
  });

  it("gives a temporary Director role on the admin's own account, once", async () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const result = await actAsClubDirector({ id: "admin-1", email: "admin@example.test" }, "club-1", now);
    expect(result).toMatchObject({ alreadyHadRole: false, expiresAt: new Date("2026-09-23T14:00:00Z") });
    expect(mocks.grantCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: "club-1", attendeeAccountId: "admin-account", role: "DIRECTOR", effectiveTo: new Date("2026-09-23T14:00:00Z"), grantedByUserId: "admin-1",
    }) });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_CLUB_DIRECTOR" });

    mocks.grantFindFirst.mockResolvedValueOnce({ role: "DIRECTOR", effectiveTo: null });
    await expect(actAsClubDirector({ id: "admin-1", email: "admin@example.test" }, "club-1", now)).resolves.toMatchObject({ alreadyHadRole: true });
    expect(mocks.grantCreate).toHaveBeenCalledTimes(1);

    mocks.orgFindUnique.mockResolvedValueOnce({ type: "CLUB", isActive: false, name: "Old" });
    await expect(actAsClubDirector({ id: "admin-1", email: "admin@example.test" }, "club-1", now)).rejects.toMatchObject({ code: "CLUB_NOT_FOUND" });
  });
});
