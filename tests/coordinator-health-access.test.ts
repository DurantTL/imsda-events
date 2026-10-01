import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  membershipFindMany: vi.fn(),
  currentAreaCoordinator: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ eventMembership: { findMany: mocks.membershipFindMany } }) }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinator: mocks.currentAreaCoordinator }));

import {
  clubLeaderHealthViewerFromAccess,
  resolveAreaHealthViewer,
  resolveStaffHealthViewer,
} from "@/modules/coordinator-health/access";

type Membership = { userId: string; eventId: string; status: "ACTIVE" | "INACTIVE"; role: string; permissions: string[] };

// A tiny stand-in for the database filter the resolver relies on.
function seedMemberships(rows: Membership[]) {
  mocks.membershipFindMany.mockImplementation(async ({ where }: { where: { userId: string; status: string; permissions: { has: string } } }) =>
    rows
      .filter((row) => row.userId === where.userId && row.status === where.status && row.permissions.includes(where.permissions.has))
      .map((row) => ({ eventId: row.eventId, permissions: row.permissions })));
}

const staff = (id: string, globalRole: "SYSTEM_ADMIN" | null = null) => ({ user: { id, globalRole } });

beforeEach(() => {
  vi.clearAllMocks();
  seedMemberships([
    { userId: "event-admin", eventId: "e1", status: "ACTIVE", role: "EVENT_ADMIN", permissions: [] },
    { userId: "registrar", eventId: "e1", status: "ACTIVE", role: "REGISTRATION_MANAGER", permissions: [] },
    { userId: "finance", eventId: "e1", status: "ACTIVE", role: "FINANCE_MANAGER", permissions: [] },
    { userId: "check-in", eventId: "e1", status: "ACTIVE", role: "CHECK_IN_STAFF", permissions: [] },
    { userId: "read-only", eventId: "e1", status: "ACTIVE", role: "READ_ONLY_STAFF", permissions: [] },
    { userId: "granted", eventId: "e1", status: "ACTIVE", role: "READ_ONLY_STAFF", permissions: ["VIEW_HEALTH_INFORMATION"] },
    { userId: "granted-inactive", eventId: "e1", status: "INACTIVE", role: "READ_ONLY_STAFF", permissions: ["VIEW_HEALTH_INFORMATION"] },
  ]);
});

describe("staff health access (#658)", () => {
  it("lets a system administrator in automatically", async () => {
    mocks.getCurrentSession.mockResolvedValue(staff("root", "SYSTEM_ADMIN"));
    expect(await resolveStaffHealthViewer()).toEqual({ kind: "SYSTEM_ADMIN", userId: "root" });
  });

  it("lets in a user whose active membership carries the grant, for that event only", async () => {
    mocks.getCurrentSession.mockResolvedValue(staff("granted"));
    expect(await resolveStaffHealthViewer()).toEqual({ kind: "HEALTH_ROLE", userId: "granted", eventIds: ["e1"] });
  });

  it.each([
    ["an Event Admin without the grant", "event-admin"],
    ["a Registration Manager (VIEW_SENSITIVE_DATA)", "registrar"],
    ["a Finance Manager (VIEW_SENSITIVE_DATA)", "finance"],
    ["Check-in staff (VIEW_SENSITIVE_DATA)", "check-in"],
    ["read-only staff", "read-only"],
    ["someone whose grant is on an inactive membership", "granted-inactive"],
    ["a user with no membership", "nobody"],
  ])("refuses %s", async (_label, userId) => {
    mocks.getCurrentSession.mockResolvedValue(staff(userId));
    expect(await resolveStaffHealthViewer()).toBeNull();
  });

  it("refuses a signed-out visitor", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect(await resolveStaffHealthViewer()).toBeNull();
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
  });
});

describe("Area Coordinator health access (#658)", () => {
  it("lets in an active Area Coordinator who passed the second step", async () => {
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-1" });
    expect(await resolveAreaHealthViewer()).toEqual({ kind: "AREA_COORDINATOR", accountId: "acct-1" });
  });

  it("refuses anyone `currentAreaCoordinator` refuses (no grant, revoked, or second step not passed)", async () => {
    mocks.currentAreaCoordinator.mockResolvedValue(null);
    expect(await resolveAreaHealthViewer()).toBeNull();
  });
});

describe("club leader health access (#658)", () => {
  const access = (role: string, actor: unknown) => ({ club: { organizationId: "club-a", role }, actor }) as never;

  it("lets in a director and a deputy, for their own club", () => {
    for (const role of ["DIRECTOR", "DEPUTY"]) {
      expect(clubLeaderHealthViewerFromAccess(access(role, { kind: "ATTENDEE", accountId: "acct-1", sessionId: "s" })))
        .toEqual({ kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } });
    }
    expect(clubLeaderHealthViewerFromAccess(access("DIRECTOR", { kind: "STAFF_ACTING", userId: "u1", actAsId: "a1", staffSessionId: "x", organizationId: "club-a" })))
      .toEqual({ kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "u1", actAsId: "a1" } });
  });

  it("refuses a registrar and a reporter", () => {
    for (const role of ["REGISTRAR", "REPORTER"]) {
      expect(clubLeaderHealthViewerFromAccess(access(role, { kind: "ATTENDEE", accountId: "acct-1", sessionId: "s" }))).toBeNull();
    }
  });
});
