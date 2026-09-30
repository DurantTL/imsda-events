import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #646: `/profile` sits under the `(workspace)` layout, whose real shell sends
 * a visitor with no staff session to the staff login. The layout therefore
 * decides first for `/profile`: attendee-only goes to `/account/profile`, a
 * signed-out browser to `/profile/sign-in`. The real WorkspaceShell runs here;
 * only the session, event and header sources are mocked. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  requestTarget: null as string | null,
  getCurrentSession: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listEventsForUser: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.requestTarget === null ? {} : { "x-imsda-request-target": mocks.requestTarget }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
  findSwitchableAttendeeAccountForStaff: vi.fn(),
}));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: mocks.listEventsForUser,
  findActiveMembership: vi.fn(),
}));
vi.mock("@/modules/events/last-used-event", () => ({ readLastUsedEventId: async () => null }));
vi.mock("@/modules/access/membership-repository", () => ({
  listActiveEventPermissionsForUser: async () => new Map(),
  listActiveEventRolesForUser: async () => new Map(),
}));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: async () => false }));
vi.mock("@/modules/access/mfa-service", () => ({ getMfaStatus: vi.fn() }));
vi.mock("@/modules/access/passkeys", () => ({ getPasskeySettings: vi.fn() }));
vi.mock("@/modules/attendee-accounts/mfa-service", () => ({ getAttendeeMfaStatus: vi.fn() }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ getPasskeySettings: vi.fn() }));
vi.mock("@/modules/communications/account-banner", () => ({ listAccountBannerAnnouncements: vi.fn() }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: vi.fn() }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/act-as-banner", () => ({ ActAsBanner: () => null }));

import WorkspaceLayout from "@/app/(workspace)/layout";

afterEach(() => {
  mocks.requestTarget = null;
  vi.clearAllMocks();
});

/** Runs the layout and then the real (async) WorkspaceShell element it returns. */
async function renderLayout() {
  const element = await WorkspaceLayout({ children: null });
  const shell = element as unknown as { type: (props: unknown) => Promise<unknown>; props: unknown };
  return shell.type(shell.props);
}

async function redirectedTo(target: string): Promise<string> {
  mocks.requestTarget = target;
  try {
    await renderLayout();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw error;
  }
  throw new Error("expected a redirect");
}

const attendeeOnly = { account: { id: "att-1", verifiedEmail: "pat@imsda-events.test" }, via: "attendee", sessionId: "a1" };
const nobody = { account: null, via: null, sessionId: null };

describe("(workspace) layout for /profile without a staff session", () => {
  it("sends an attendee-only browser to /account/profile, carrying ?twoStep=on", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    mocks.getCurrentAttendee.mockResolvedValue(attendeeOnly);
    expect(await redirectedTo("/profile")).toBe("/account/profile");
    expect(await redirectedTo("/profile?twoStep=on")).toBe("/account/profile?twoStep=on");
  });

  it("sends a signed-out browser to the sign-in chooser, not the staff login", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    mocks.getCurrentAttendee.mockResolvedValue(nobody);
    expect(await redirectedTo("/profile")).toBe("/profile/sign-in");
    expect(mocks.listEventsForUser).not.toHaveBeenCalled();
  });

  it("still sends a signed-out request for any other workspace page to the staff login", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    mocks.getCurrentAttendee.mockResolvedValue(attendeeOnly);
    expect(await redirectedTo("/overview")).toBe("/login?next=%2Foverview");
  });

  it("lets staff with no events through to the page for /profile only", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", email: "riley@imsda-events.test", globalRole: null } });
    mocks.getCurrentAttendee.mockResolvedValue(nobody);
    mocks.listEventsForUser.mockResolvedValue([]);
    mocks.requestTarget = "/profile";
    await expect(renderLayout()).resolves.toBeTruthy();
    expect(await redirectedTo("/overview")).toBe("/no-access");
  });
});
