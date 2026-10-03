import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  getCurrentSession: vi.fn(),
  resolveAreaCoordinatorViewer: vi.fn(),
  membershipFindMany: vi.fn(),
  eventFindUnique: vi.fn(),
  guardianFindMany: vi.fn(),
  memberFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/club-forms/access", () => ({ resolveAreaCoordinatorViewer: mocks.resolveAreaCoordinatorViewer }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual };
});

import { RosterAccessError } from "@/modules/club-rosters/access";
import {
  clubLeaderGuardianViewerFromAccess,
  requireGuardianEditor,
  resolveAreaGuardianViewer,
  resolveStaffGuardianViewer,
  rosterGuardiansForAccess,
} from "@/modules/club-rosters/guardians-access";
import { GuardianAccessError, listGuardianContactsForClub, listGuardiansByMember } from "@/modules/club-rosters/guardians-repository";
import type { GuardianViewer } from "@/modules/club-rosters/guardians-domain";
import { clubCapabilities, type ClubRole } from "@/modules/organizations/director-grants-domain";

const attendeeActor = { kind: "ATTENDEE" as const, accountId: "account-1", sessionId: "session-1" };

function openAccess(role: ClubRole, organizationId = "club-1", actor: unknown = attendeeActor) {
  return {
    state: "OPEN" as const,
    club: { organizationId, name: "Synthetic Club", role, sponsoringChurch: null },
    capabilities: clubCapabilities(role),
    actor,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.getPrisma.mockReturnValue({
    eventMembership: { findMany: mocks.membershipFindMany },
    event: { findUnique: mocks.eventFindUnique },
    clubRosterGuardian: { findMany: mocks.guardianFindMany },
    clubRosterMember: { findMany: mocks.memberFindMany },
  });
  mocks.membershipFindMany.mockResolvedValue([]);
  mocks.eventFindUnique.mockResolvedValue({ timezone: "America/Chicago", endsAt: new Date("2099-01-01T00:00:00Z") });
  mocks.guardianFindMany.mockResolvedValue([]);
  mocks.memberFindMany.mockResolvedValue([]);
});

describe("guardian viewers from a club role (#510)", () => {
  it("gives a viewer to the club's director and deputy only", () => {
    for (const role of ["DIRECTOR", "DEPUTY"] as const) {
      expect(clubLeaderGuardianViewerFromAccess(openAccess(role))).toEqual({
        kind: "CLUB_LEADER", organizationId: "club-1", actor: { kind: "ATTENDEE", accountId: "account-1" },
      });
    }
    for (const role of ["REGISTRAR", "REPORTER"] as const) {
      expect(clubLeaderGuardianViewerFromAccess(openAccess(role))).toBeNull();
    }
  });

  it("maps a staff member acting as the director to a leader viewer with its act-as", () => {
    const viewer = clubLeaderGuardianViewerFromAccess(openAccess("DIRECTOR", "club-1", { kind: "STAFF_ACTING", userId: "admin-1", staffSessionId: "s", actAsId: "act-1", organizationId: "club-1" }));
    expect(viewer).toMatchObject({ kind: "CLUB_LEADER", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } });
  });

  it("refuses every edit from a role without guardians access with a 403", () => {
    for (const role of ["REGISTRAR", "REPORTER"] as const) {
      expect(() => requireGuardianEditor(openAccess(role))).toThrow(RosterAccessError);
      try {
        requireGuardianEditor(openAccess(role));
      } catch (error) {
        expect(error).toMatchObject({ code: "ROLE_NOT_ALLOWED", status: 403 });
      }
    }
    expect(requireGuardianEditor(openAccess("DEPUTY"))).toMatchObject({ kind: "CLUB_LEADER" });
  });

  it("returns guardians for the roster response to a director, and nothing at all to a registrar", async () => {
    mocks.guardianFindMany.mockResolvedValue([
      { rosterMemberId: "member-1", position: 1, name: "Synthetic Guardian", relationship: "Mother", email: "", phone: "" },
    ]);
    await expect(rosterGuardiansForAccess(openAccess("DIRECTOR"), "club-1", "2026-27")).resolves.toEqual({
      "member-1": [{ position: 1, name: "Synthetic Guardian", relationship: "Mother", email: "", phone: "" }],
    });
    mocks.guardianFindMany.mockClear();
    await expect(rosterGuardiansForAccess(openAccess("REGISTRAR"), "club-1", "2026-27")).resolves.toBeUndefined();
    expect(mocks.guardianFindMany).not.toHaveBeenCalled();
  });
});

describe("guardian viewers for coordinators and staff (#510)", () => {
  it("makes every Area Coordinator a viewer, and anyone else nothing", async () => {
    mocks.resolveAreaCoordinatorViewer.mockResolvedValueOnce({ kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "coordinator-1" } });
    await expect(resolveAreaGuardianViewer()).resolves.toEqual({ kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "coordinator-1" } });
    mocks.resolveAreaCoordinatorViewer.mockResolvedValueOnce({ kind: "AREA_COORDINATOR", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } });
    await expect(resolveAreaGuardianViewer()).resolves.toMatchObject({ actor: { kind: "STAFF_ACTING", actAsId: "act-1" } });
    mocks.resolveAreaCoordinatorViewer.mockResolvedValueOnce(null);
    await expect(resolveAreaGuardianViewer()).resolves.toBeNull();
  });

  it("allows a system administrator without reading any membership", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", globalRole: "SYSTEM_ADMIN" } });
    await expect(resolveStaffGuardianViewer()).resolves.toEqual({ kind: "STAFF", userId: "admin-1" });
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ["EVENT_ADMIN", [], true],
    ["REGISTRATION_MANAGER", [], true],
    ["FINANCE_MANAGER", [], true],
    ["CHECK_IN_STAFF", [], true],
    ["READ_ONLY_STAFF", ["VIEW_SENSITIVE_DATA"], true],
    ["COMMUNICATIONS_MANAGER", [], false],
    ["READ_ONLY_STAFF", [], false],
    ["READ_ONLY_STAFF", ["VIEW_REPORTS"], false],
  ])("staff role %s with extra grants %j: allowed is %s", async (role, permissions, allowed) => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: "STAFF" } });
    mocks.membershipFindMany.mockResolvedValue([{ eventId: "event-1", status: "ACTIVE", role, permissions }]);
    await expect(resolveStaffGuardianViewer("event-1")).resolves.toEqual(allowed ? { kind: "STAFF", userId: "staff-1" } : null);
  });

  it("narrows to one event's membership when a page is scoped to an event", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: "STAFF" } });
    mocks.membershipFindMany.mockResolvedValue([{ eventId: "event-1", status: "ACTIVE", role: "EVENT_ADMIN", permissions: [] }]);
    await resolveStaffGuardianViewer("event-1");
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "staff-1", status: "ACTIVE", eventId: "event-1" } }));
  });

  it("refuses staff once the event has ended, but never a system administrator", async () => {
    mocks.eventFindUnique.mockResolvedValue({ timezone: "America/Chicago", endsAt: new Date("2026-06-01T00:00:00Z") });
    mocks.membershipFindMany.mockResolvedValue([{ eventId: "event-1", status: "ACTIVE", role: "EVENT_ADMIN", permissions: [] }]);
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: "STAFF" } });
    await expect(resolveStaffGuardianViewer("event-1", new Date("2026-10-03T12:00:00Z"))).resolves.toBeNull();
    // Still open on the event's last day, in the event's time zone.
    await expect(resolveStaffGuardianViewer("event-1", new Date("2026-05-31T12:00:00Z"))).resolves.toEqual({ kind: "STAFF", userId: "staff-1" });
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", globalRole: "SYSTEM_ADMIN" } });
    await expect(resolveStaffGuardianViewer("event-1", new Date("2026-10-03T12:00:00Z"))).resolves.toEqual({ kind: "STAFF", userId: "admin-1" });
  });

  it("gives non-admin staff nothing when no event is named, or the event is unknown", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: "STAFF" } });
    mocks.membershipFindMany.mockResolvedValue([{ eventId: "event-1", status: "ACTIVE", role: "EVENT_ADMIN", permissions: [] }]);
    await expect(resolveStaffGuardianViewer()).resolves.toBeNull();
    mocks.eventFindUnique.mockResolvedValue(null);
    await expect(resolveStaffGuardianViewer("event-1")).resolves.toBeNull();
  });

  it("gives nothing to a signed-out visitor or an ordinary attendee (no staff session)", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    mocks.resolveAreaCoordinatorViewer.mockResolvedValue(null);
    await expect(resolveStaffGuardianViewer()).resolves.toBeNull();
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
  });
});

describe("reading guardian contacts (#510)", () => {
  const leader = (organizationId: string): GuardianViewer => ({ kind: "CLUB_LEADER", organizationId, actor: { kind: "ATTENDEE", accountId: "account-1" } });
  const coordinator: GuardianViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "coordinator-1" } };
  const staff: GuardianViewer = { kind: "STAFF", userId: "staff-1" };
  const member = {
    id: "member-1",
    attendeeType: "YOUTH",
    status: "ACTIVE",
    person: { firstName: "Test", lastName: "Youth" },
    guardians: [
      { position: 1, name: "Synthetic Guardian One", relationship: "Mother", email: "one@example.test", phone: "(555) 010-0101" },
      { position: 2, name: "Synthetic Guardian Two", relationship: "Uncle", email: "", phone: "" },
    ],
  };

  it("never reads another club's guardians for a director or deputy", async () => {
    await expect(listGuardiansByMember(leader("club-1"), "club-2", "2026-27")).rejects.toBeInstanceOf(GuardianAccessError);
    await expect(listGuardianContactsForClub(leader("club-1"), "club-2", "2026-27")).rejects.toBeInstanceOf(GuardianAccessError);
    expect(mocks.guardianFindMany).not.toHaveBeenCalled();
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("lets a director read their own club's contacts without an audit entry", async () => {
    mocks.memberFindMany.mockResolvedValue([member]);
    const contacts = await listGuardianContactsForClub(leader("club-1"), "club-1", "2026-27");
    expect(contacts).toEqual([expect.objectContaining({ memberId: "member-1", firstName: "Test", guardians: expect.any(Array) })]);
    expect(contacts[0]!.guardians).toHaveLength(2);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lets any Area Coordinator and sensitive-data staff read any club, audited with counts only", async () => {
    mocks.memberFindMany.mockResolvedValue([member]);
    for (const viewer of [coordinator, staff]) {
      mocks.writeAuditLog.mockClear();
      const contacts = await listGuardianContactsForClub(viewer, "club-77", "2026-27");
      expect(contacts).toHaveLength(1);
      expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
      const [entry] = mocks.writeAuditLog.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: "CLUB_ROSTER_GUARDIANS_VIEWED",
        entityType: "Organization",
        entityId: "club-77",
        metadata: { organizationId: "club-77", clubYear: "2026-27", memberCount: 1, guardianCount: 2 },
      });
      const serialized = JSON.stringify(entry);
      for (const value of ["Synthetic Guardian", "one@example.test", "010-0101", "Mother", "Uncle", "Test", "Youth"]) {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it("returns nothing if the audit write fails", async () => {
    mocks.memberFindMany.mockResolvedValue([member]);
    mocks.writeAuditLog.mockRejectedValueOnce(new Error("audit down"));
    await expect(listGuardianContactsForClub(coordinator, "club-1", "2026-27")).rejects.toThrow("audit down");
  });

  it("asks only for people still on the roster", async () => {
    await listGuardianContactsForClub(coordinator, "club-1", "2026-27");
    expect(mocks.memberFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "club-1", clubYear: "2026-27", status: { not: "REMOVED" }, guardians: { some: {} } },
    }));
    await listGuardiansByMember(leader("club-1"), "club-1", "2026-27");
    expect(mocks.guardianFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rosterMember: { organizationId: "club-1", clubYear: "2026-27", status: { not: "REMOVED" } } },
    }));
  });
});
