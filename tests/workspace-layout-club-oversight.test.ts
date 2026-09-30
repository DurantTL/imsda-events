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
    expect(banner?.props).toEqual({ acting });
  });
});
