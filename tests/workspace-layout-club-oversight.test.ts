import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #481: the workspace layout computes each shell event's `clubOversight`
 * from the event's audience, not its billing mode — true only for a
 * CLUB-audience event, for a system admin or an EVENT_ADMIN.
 */
const mocks = vi.hoisted(() => ({
  loadWorkspaceEventContext: vi.fn(),
  listActiveEventPermissionsForUser: vi.fn(),
  listActiveEventRolesForUser: vi.fn(),
  findSwitchableAttendeeAccountForStaff: vi.fn(),
  currentStaffActingContext: vi.fn(),
  moduleStatesByEvent: vi.fn(),
  getCurrentSession: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/events/selection", () => ({ loadWorkspaceEventContext: mocks.loadWorkspaceEventContext }));
vi.mock("@/modules/access/membership-repository", () => ({
  listActiveEventPermissionsForUser: mocks.listActiveEventPermissionsForUser,
  listActiveEventRolesForUser: mocks.listActiveEventRolesForUser,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  findSwitchableAttendeeAccountForStaff: mocks.findSwitchableAttendeeAccountForStaff,
}));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/event-modules/service", () => ({ moduleStatesByEvent: mocks.moduleStatesByEvent }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ eventMembership: { findMany: mocks.findMany } }) }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/act-as-banner", () => ({ ActAsBanner: () => null }));

import { AppShell } from "@/components/app-shell";
import { ActAsBanner } from "@/components/act-as-banner";
import { WorkspaceShell } from "@/components/workspace-shell";

type ShellEvent = { id: string; clubOversight: boolean };

const events = [
  { id: "evt_general_billed", slug: "general-billed", name: "General, billed to church", audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
  { id: "evt_club_paid", slug: "club-paid", name: "Club, attendee-paid", audience: "CLUB", billingMode: "ATTENDEE_PAY" },
];

function shellEvents(tree: ReactElement): ShellEvent[] {
  const children = (tree.props as { children: ReactNode }).children;
  const shell = (Array.isArray(children) ? children : [children])
    .find((child): child is ReactElement => Boolean(child) && (child as ReactElement).type === AppShell);
  if (!shell) throw new Error("layout rendered no AppShell");
  return (shell.props as { events: ShellEvent[] }).events;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSwitchableAttendeeAccountForStaff.mockResolvedValue(null);
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.moduleStatesByEvent.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, { stored: new Set(["public-content"]), effective: new Set(["public-content"]) }])));
});

describe("WorkspaceShell club oversight (#481)", () => {
  it("gives a system admin club oversight only on the CLUB-audience event", async () => {
    mocks.loadWorkspaceEventContext.mockResolvedValue({
      autoSelected: false, defaultEventId: null, events,
      user: { id: "usr_admin", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" },
    });
    const tree = await WorkspaceShell({ children: null });
    expect(shellEvents(tree)).toEqual([
      expect.objectContaining({ id: "evt_general_billed", clubOversight: false }),
      expect.objectContaining({ id: "evt_club_paid", clubOversight: true }),
    ]);
  });

  it("gives an EVENT_ADMIN club oversight only on the CLUB-audience event, and other roles none", async () => {
    mocks.loadWorkspaceEventContext.mockResolvedValue({
      autoSelected: false, defaultEventId: null, events: [...events, { id: "evt_club_other", slug: "club-other", name: "Club, other role", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }],
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    mocks.listActiveEventPermissionsForUser.mockResolvedValue(new Map());
    mocks.listActiveEventRolesForUser.mockResolvedValue(new Map([
      ["evt_general_billed", "EVENT_ADMIN"],
      ["evt_club_paid", "EVENT_ADMIN"],
      ["evt_club_other", "REGISTRATION_MANAGER"],
    ]));
    const tree = await WorkspaceShell({ children: null });
    expect(shellEvents(tree)).toEqual([
      expect.objectContaining({ id: "evt_general_billed", clubOversight: false }),
      expect.objectContaining({ id: "evt_club_paid", clubOversight: true }),
      expect.objectContaining({ id: "evt_club_other", clubOversight: false }),
    ]);
  });

  it("hands each event's disabled module cards and the club forms rule to the launcher (#741)", async () => {
    mocks.loadWorkspaceEventContext.mockResolvedValue({
      autoSelected: false, defaultEventId: null,
      events: [
        ...events,
        { id: "evt_club_other", slug: "club-other", name: "Club, other role", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
        { id: "evt_club_ended", slug: "club-ended", name: "Club, ended", audience: "CLUB", billingMode: "ATTENDEE_PAY", timezone: "America/Chicago", endsAt: new Date("2020-01-02T00:00:00Z") },
      ],
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    mocks.listActiveEventPermissionsForUser.mockResolvedValue(new Map());
    mocks.listActiveEventRolesForUser.mockResolvedValue(new Map([
      ["evt_general_billed", "EVENT_ADMIN"],
      ["evt_club_paid", "EVENT_ADMIN"],
      ["evt_club_other", "REGISTRATION_MANAGER"],
      ["evt_club_ended", "EVENT_ADMIN"],
    ]));
    mocks.moduleStatesByEvent.mockResolvedValue(new Map([
      ["evt_club_paid", { stored: new Set(["public-content"]), effective: new Set(["public-content", "merchandise"]) }],
      ["evt_general_billed", { stored: new Set(["public-content"]), effective: new Set(["public-content"]) }],
    ]));
    const tree = await WorkspaceShell({ children: null });
    const shell = shellEvents(tree) as unknown as Array<{ id: string; hiddenCardKeys: string[]; clubFormsAccess: boolean }>;
    const byId = Object.fromEntries(shell.map((event) => [event.id, event]));
    // A module with no row is hidden; one with a row is not; Public content is always on.
    expect(byId.evt_club_paid.hiddenCardKeys).not.toContain("merchandise");
    expect(byId.evt_club_paid.hiddenCardKeys).not.toContain("event-content");
    expect(byId.evt_club_paid.hiddenCardKeys).toEqual(expect.arrayContaining(["honors", "event-patches", "club-assignments", "program-assignments", "community"]));
    expect(byId.evt_general_billed.hiddenCardKeys).toContain("merchandise");
    // Club forms are one answer per user, not per event: this user is an Event Admin of a current event.
    expect(shell.every((event) => event.clubFormsAccess === true)).toBe(true);
  });

  it("loads module state only for events that have not ended, and the default event; others get no hidden set", async () => {
    const ended = { id: "evt_ended", slug: "ended", name: "Ended", audience: "CLUB", timezone: "America/Chicago", endsAt: new Date("2020-01-02T00:00:00Z") };
    mocks.loadWorkspaceEventContext.mockResolvedValue({
      autoSelected: false, defaultEventId: null, events: [...events, ended],
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    mocks.listActiveEventPermissionsForUser.mockResolvedValue(new Map());
    mocks.listActiveEventRolesForUser.mockResolvedValue(new Map());
    const tree = await WorkspaceShell({ children: null });
    expect(mocks.moduleStatesByEvent).toHaveBeenCalledWith(["evt_general_billed", "evt_club_paid"]);
    const byId = Object.fromEntries((shellEvents(tree) as unknown as Array<{ id: string; hiddenCardKeys?: string[] }>).map((event) => [event.id, event]));
    expect(byId.evt_ended.hiddenCardKeys).toBeUndefined();
    expect(byId.evt_club_paid.hiddenCardKeys).toBeDefined();
  });

  it("passes the no-events allowance through to the event context (#623)", async () => {
    mocks.loadWorkspaceEventContext.mockResolvedValue({
      autoSelected: false, defaultEventId: null, events: [],
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    mocks.listActiveEventPermissionsForUser.mockResolvedValue(new Map());
    mocks.listActiveEventRolesForUser.mockResolvedValue(new Map());
    const tree = await WorkspaceShell({ anyStaffWithoutEvents: true, children: null });
    expect(mocks.loadWorkspaceEventContext).toHaveBeenCalledWith({ anyStaffWithoutEvents: true });
    expect(shellEvents(tree)).toEqual([]);
    await WorkspaceShell({ children: null });
    expect(mocks.loadWorkspaceEventContext).toHaveBeenLastCalledWith({ anyStaffWithoutEvents: false });
  });

  it("hands the acting context to the act-as banner (#623)", async () => {
    const acting = { role: "CLUB_DIRECTOR", organizationName: "Synthetic Club" };
    mocks.currentStaffActingContext.mockResolvedValue(acting);
    mocks.loadWorkspaceEventContext.mockResolvedValue({
      autoSelected: false, defaultEventId: null, events,
      user: { id: "usr_admin", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" },
    });
    const tree = await WorkspaceShell({ children: null });
    const children = (tree.props as { children: ReactNode }).children;
    const banner = (Array.isArray(children) ? children : [children])
      .find((child): child is ReactElement => Boolean(child) && (child as ReactElement).type === ActAsBanner);
    expect(banner?.props).toEqual({ acting, inShell: true });
  });
});

describe("Club forms access agrees between the shell and /more (#741 review)", () => {
  const current = { timezone: "America/Chicago", endsAt: new Date("2099-01-02T00:00:00Z") };
  const past = { timezone: "America/Chicago", endsAt: new Date("2020-01-02T00:00:00Z") };
  const cases: Array<{ name: string; globalRole: "SYSTEM_ADMIN" | null; roles: Array<[string, "EVENT_ADMIN" | "REGISTRATION_MANAGER"]>; times: Record<string, typeof current> }> = [
    { name: "system admin", globalRole: "SYSTEM_ADMIN", roles: [["a", "REGISTRATION_MANAGER"]], times: { a: current } },
    { name: "Event Admin of a current event", globalRole: null, roles: [["a", "EVENT_ADMIN"]], times: { a: current } },
    { name: "Event Admin of an ended event only", globalRole: null, roles: [["a", "EVENT_ADMIN"]], times: { a: past } },
    { name: "Event Admin of an ended and a current event", globalRole: null, roles: [["a", "EVENT_ADMIN"], ["b", "EVENT_ADMIN"]], times: { a: past, b: current } },
    { name: "another role on a current event", globalRole: null, roles: [["a", "REGISTRATION_MANAGER"]], times: { a: current } },
  ];

  for (const entry of cases) {
    it(`${entry.name}: the shell flag equals what resolveStaffViewer decides`, async () => {
      const user = { id: "usr_x", email: "x@example.test", displayName: "X", globalRole: entry.globalRole };
      const shellEventsInput = entry.roles.map(([id]) => ({ id: `evt_${id}`, slug: id, name: id, audience: "GENERAL", ...entry.times[id] }));
      mocks.loadWorkspaceEventContext.mockResolvedValue({ autoSelected: false, defaultEventId: null, events: shellEventsInput, user });
      mocks.listActiveEventPermissionsForUser.mockResolvedValue(new Map());
      mocks.listActiveEventRolesForUser.mockResolvedValue(new Map(entry.roles.map(([id, role]) => [`evt_${id}`, role])));
      const tree = await WorkspaceShell({ children: null });
      const flags = (shellEvents(tree) as unknown as Array<{ clubFormsAccess: boolean }>).map((event) => event.clubFormsAccess);

      mocks.getCurrentSession.mockResolvedValue({ user });
      // The database filters to ACTIVE EVENT_ADMIN memberships; mirror that here.
      mocks.findMany.mockResolvedValue(entry.roles.filter(([, role]) => role === "EVENT_ADMIN").map(([id, role]) => ({ role, event: entry.times[id] })));
      const { resolveStaffViewer } = await import("@/modules/club-forms/access");
      const viewer = await resolveStaffViewer();
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) expect(flag).toBe(viewer !== null);
      expect(new Set(flags).size).toBeLessThanOrEqual(1);
    });
  }
});
