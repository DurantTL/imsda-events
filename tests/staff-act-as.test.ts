import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  orgFindUnique: vi.fn(),
  sessionFindUnique: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const client = {
  staffActAs: { findFirst: mocks.findFirst, updateMany: mocks.updateMany, create: mocks.create, update: mocks.update },
  organization: { findUnique: mocks.orgFindUnique },
  userSession: { findUnique: mocks.sessionFindUnique },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import {
  actAsAreaCoordinator,
  actAsClubDirector,
  endActiveActAsOnSignOut,
  resolveActiveActAs,
  StaffActAsError,
  stopActingAs,
} from "@/modules/organizations/staff-act-as";

const now = new Date("2026-09-26T12:00:00Z");
const validStaffSession = {
  expiresAt: new Date("2026-09-26T18:00:00Z"),
  revokedAt: null,
  lastSeenAt: new Date("2026-09-26T11:59:00Z"),
  user: { accountStatus: "ACTIVE", credential: { disabledAt: null } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.create.mockResolvedValue({ id: "act-1" });
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Test Pathfinders" });
  mocks.sessionFindUnique.mockResolvedValue(validStaffSession);
});

describe("staff act-as (#442)", () => {
  it("starts acting as an Area Coordinator, ending any active act-as first", async () => {
    const result = await actAsAreaCoordinator({ id: "admin-1" }, "staff-session-1", now);
    expect(result).toEqual({ expiresAt: new Date("2026-09-26T14:00:00Z"), actAsId: "act-1" });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { staffSessionId: "staff-session-1", endedAt: null },
      data: { endedAt: now, endedReason: "REPLACED" },
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "admin-1", staffSessionId: "staff-session-1", role: "AREA_COORDINATOR", organizationId: null }),
    }));
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_AREA_COORDINATOR", actorUserId: "admin-1" });
  });

  it("starts acting as a club's director, refusing an inactive or missing club", async () => {
    const result = await actAsClubDirector({ id: "admin-1" }, "staff-session-1", "club-1", now);
    expect(result).toMatchObject({ expiresAt: new Date("2026-09-26T14:00:00Z"), actAsId: "act-1", clubName: "Test Pathfinders" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "CLUB_DIRECTOR", organizationId: "club-1" }),
    }));
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_CLUB_DIRECTOR" });

    mocks.orgFindUnique.mockResolvedValueOnce(null);
    await expect(actAsClubDirector({ id: "admin-1" }, "staff-session-1", "club-x", now))
      .rejects.toThrow(StaffActAsError);

    mocks.orgFindUnique.mockResolvedValueOnce({ type: "CLUB", isActive: false, name: "Old" });
    await expect(actAsClubDirector({ id: "admin-1" }, "staff-session-1", "club-1", now))
      .rejects.toMatchObject({ code: "CLUB_NOT_FOUND" });
  });

  it("resolves the active act-as only while not expired and the staff session is valid", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR",
      organizationId: "club-1", expiresAt: new Date("2026-09-26T14:00:00Z"),
    });
    await expect(resolveActiveActAs("staff-session-1", now)).resolves.toMatchObject({ id: "act-1", role: "CLUB_DIRECTOR" });

    // Past its expiry: inactive, and best-effort marked EXPIRED.
    mocks.findFirst.mockResolvedValue({
      id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR",
      organizationId: "club-1", expiresAt: new Date("2026-09-26T11:00:00Z"),
    });
    await expect(resolveActiveActAs("staff-session-1", now)).resolves.toBeNull();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { endedAt: now, endedReason: "EXPIRED" } }));

    // Not expired, but the staff session itself is dead (revoked): inactive
    // even though nothing wrote endedAt.
    mocks.findFirst.mockResolvedValue({
      id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR",
      organizationId: "club-1", expiresAt: new Date("2026-09-26T14:00:00Z"),
    });
    mocks.sessionFindUnique.mockResolvedValueOnce({ ...validStaffSession, revokedAt: new Date() });
    await expect(resolveActiveActAs("staff-session-1", now)).resolves.toBeNull();

    // Nothing active at all.
    mocks.findFirst.mockResolvedValue(null);
    await expect(resolveActiveActAs("staff-session-1", now)).resolves.toBeNull();
  });

  it("ends the active act-as on Stop acting, auditing the role and club", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", role: "CLUB_DIRECTOR", organizationId: "club-1" });
    const stopped = await stopActingAs({ id: "admin-1" }, "staff-session-1", now);
    expect(stopped).toMatchObject({ id: "act-1" });
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "act-1" }, data: { endedAt: now, endedReason: "STOPPED" } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_STOPPED", actorUserId: "admin-1" });

    mocks.findFirst.mockResolvedValueOnce(null);
    await expect(stopActingAs({ id: "admin-1" }, "staff-session-1", now)).resolves.toBeNull();
  });

  it("ends the active act-as on sign-out, never throwing", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", userId: "admin-1", role: "AREA_COORDINATOR", organizationId: null });
    await endActiveActAsOnSignOut("staff-session-1", now);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "act-1" }, data: { endedAt: now, endedReason: "SIGNED_OUT" } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_STOPPED", actorUserId: "admin-1" });

    mocks.findFirst.mockResolvedValueOnce(null);
    await expect(endActiveActAsOnSignOut("staff-session-1", now)).resolves.toBeUndefined();
  });
});
