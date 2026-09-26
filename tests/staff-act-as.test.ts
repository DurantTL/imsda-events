import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  orgFindUnique: vi.fn(),
  sessionFindUnique: vi.fn(),
  writeAuditLog: vi.fn(),
  getCurrentSession: vi.fn(),
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
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));

import { Prisma } from "@prisma/client";
import {
  actAsAreaCoordinator,
  actAsClubDirector,
  currentStaffActingContext,
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
  user: { id: "admin-1", globalRole: "SYSTEM_ADMIN", accountStatus: "ACTIVE", credential: { disabledAt: null } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.create.mockResolvedValue({ id: "act-1" });
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Test Pathfinders" });
  mocks.sessionFindUnique.mockResolvedValue(validStaffSession);
  mocks.getCurrentSession.mockResolvedValue({
    user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" },
    sessionId: "staff-session-1",
  });
});

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on StaffActAs_staffSessionId_active_key", {
    code: "P2002",
    clientVersion: "test",
  });
}

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
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", role: "CLUB_DIRECTOR", organizationId: "club-1" });
    const stopped = await stopActingAs({ id: "admin-1" }, "staff-session-1", now);
    expect(stopped).toMatchObject({ id: "act-1" });
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "act-1", endedAt: null }, data: { endedAt: now, endedReason: "STOPPED" } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_STOPPED", actorUserId: "admin-1" });

    mocks.findFirst.mockResolvedValueOnce(null);
    await expect(stopActingAs({ id: "admin-1" }, "staff-session-1", now)).resolves.toBeNull();
  });

  it("ends the active act-as on sign-out, never throwing", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", userId: "admin-1", role: "AREA_COORDINATOR", organizationId: null });
    await endActiveActAsOnSignOut("staff-session-1", now);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "act-1", endedAt: null }, data: { endedAt: now, endedReason: "SIGNED_OUT" } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "ACT_AS_STOPPED", actorUserId: "admin-1" });

    mocks.findFirst.mockResolvedValueOnce(null);
    await expect(endActiveActAsOnSignOut("staff-session-1", now)).resolves.toBeUndefined();
  });

  it("never overwrites a concurrent Stop acting on sign-out: the update is guarded on endedAt null", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "act-1", userId: "admin-1", role: "CLUB_DIRECTOR", organizationId: "club-1" });
    // Someone else ended it (STOPPED) between the read and the update.
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await endActiveActAsOnSignOut("staff-session-1", now);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("retries a start that raced another on the same session once, then reports a conflict (P2002 -> ACT_AS_CONFLICT)", async () => {
    mocks.create.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce({ id: "act-2" });
    await expect(actAsAreaCoordinator({ id: "admin-1" }, "staff-session-1", now)).resolves.toMatchObject({ actAsId: "act-2" });
    // The retry ended the winner's row first, like any restart.
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);

    mocks.create.mockRejectedValueOnce(uniqueViolation()).mockRejectedValueOnce(uniqueViolation());
    await expect(actAsClubDirector({ id: "admin-1" }, "staff-session-1", "club-1", now))
      .rejects.toMatchObject({ name: "StaffActAsError", code: "ACT_AS_CONFLICT" });

    // Anything else is not swallowed.
    mocks.create.mockRejectedValueOnce(new Error("database down"));
    await expect(actAsAreaCoordinator({ id: "admin-1" }, "staff-session-1", now)).rejects.toThrow("database down");
  });
});

describe("currentStaffActingContext (#442)", () => {
  const activeRow = (overrides: Record<string, unknown> = {}) => ({
    id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR",
    organizationId: "club-1", expiresAt: new Date(Date.now() + 60 * 60_000), ...overrides,
  });
  const liveSession = () => ({ ...validStaffSession, expiresAt: new Date(Date.now() + 6 * 3_600_000), lastSeenAt: new Date() });

  beforeEach(() => {
    mocks.sessionFindUnique.mockResolvedValue(liveSession());
  });

  it("returns this staff session's own active act-as", async () => {
    mocks.findFirst.mockResolvedValue(activeRow());
    await expect(currentStaffActingContext()).resolves.toMatchObject({
      userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-1", role: "CLUB_DIRECTOR", organizationId: "club-1",
    });
    // Looked up by this session only.
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { staffSessionId: "staff-session-1", endedAt: null } }));
  });

  it("ignores a row that belongs to a different user", async () => {
    mocks.findFirst.mockResolvedValue(activeRow({ userId: "admin-2" }));
    await expect(currentStaffActingContext()).resolves.toBeNull();
  });

  it("ignores a row that belongs to a different staff session", async () => {
    mocks.findFirst.mockResolvedValue(activeRow({ staffSessionId: "staff-session-other" }));
    await expect(currentStaffActingContext()).resolves.toBeNull();
  });

  it("ignores the act-as once the user is no longer a system administrator, or is disabled", async () => {
    mocks.findFirst.mockResolvedValue(activeRow());
    mocks.getCurrentSession.mockResolvedValueOnce({
      user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: null },
      sessionId: "staff-session-1",
    });
    await expect(currentStaffActingContext()).resolves.toBeNull();

    // The staff session's own user record says demoted (a stale cached session read is not trusted alone).
    mocks.sessionFindUnique.mockResolvedValueOnce({ ...liveSession(), user: { ...liveSession().user, globalRole: null } });
    await expect(currentStaffActingContext()).resolves.toBeNull();

    mocks.sessionFindUnique.mockResolvedValueOnce({ ...liveSession(), user: { ...liveSession().user, credential: { disabledAt: new Date() } } });
    await expect(currentStaffActingContext()).resolves.toBeNull();

    mocks.sessionFindUnique.mockResolvedValueOnce({ ...liveSession(), user: { ...liveSession().user, accountStatus: "DISABLED" } });
    await expect(currentStaffActingContext()).resolves.toBeNull();

    // Still fine once all of that is back.
    await expect(currentStaffActingContext()).resolves.toMatchObject({ actAsId: "act-1" });
  });

  it("is null with no staff session at all", async () => {
    mocks.getCurrentSession.mockResolvedValueOnce({ user: null });
    await expect(currentStaffActingContext()).resolves.toBeNull();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});
