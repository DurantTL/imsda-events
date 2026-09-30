import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #543: `/profile` is one page for every account. It reads the staff and the
 * attendee session separately (ADR 0003), needs no event, and each account's
 * section appears only when that session is present.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  getCurrentAttendee: vi.fn(),
  attendeeSecondStepPending: vi.fn(),
  requireAttendeeSecondStep: vi.fn(),
  listDirectedClubs: vi.fn(),
  getMfaStatus: vi.fn(),
  getPasskeySettings: vi.fn(),
  currentStaffActingContext: vi.fn(),
  listAccountBannerAnnouncements: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({
  attendeeSecondStepPending: mocks.attendeeSecondStepPending,
  requireAttendeeSecondStep: mocks.requireAttendeeSecondStep,
}));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
const attendeeMfaStatus = vi.hoisted(() => vi.fn());
const attendeePasskeys = vi.hoisted(() => vi.fn());
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ getPasskeySettings: attendeePasskeys }));
vi.mock("@/modules/attendee-accounts/mfa-service", () => ({ getAttendeeMfaStatus: attendeeMfaStatus }));
vi.mock("@/modules/access/mfa-service", () => ({ getMfaStatus: mocks.getMfaStatus }));
vi.mock("@/modules/access/passkeys", () => ({ getPasskeySettings: mocks.getPasskeySettings }));
vi.mock("@/components/mfa-manager", () => ({
  MfaManager: (props: { attendee?: boolean }) => createElement("div", { "data-manager": props.attendee ? "attendee-mfa" : "staff-mfa" }),
}));
vi.mock("@/components/staff-passkey-manager", () => ({
  StaffPasskeyManager: () => createElement("div", { "data-manager": "staff-passkeys" }),
}));
vi.mock("@/components/attendee-account-settings", () => ({
  AttendeeAccountSettings: () => createElement("div", { "data-manager": "attendee-settings" }),
}));
vi.mock("@/components/attendee-sign-out-button", () => ({
  AttendeeSignOutButton: (props: { label?: string }) => createElement("button", { type: "button" }, props.label ?? "Sign out"),
}));
vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: (props: { label?: string }) => createElement("button", { type: "button" }, props.label ?? "Sign out"),
}));
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: (props: { anyStaffWithoutEvents?: boolean; children: React.ReactNode }) =>
    createElement("div", { "data-shell": "staff", "data-any-staff": String(Boolean(props.anyStaffWithoutEvents)) }, props.children),
}));
vi.mock("@/components/act-as-banner", () => ({
  ActAsBanner: (props: { acting: unknown }) => (props.acting ? createElement("aside", null, "ACT-AS-BANNER") : null),
}));
vi.mock("@/modules/communications/account-banner", () => ({ listAccountBannerAnnouncements: mocks.listAccountBannerAnnouncements }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));

import ProfilePage from "@/app/(workspace)/profile/page";
import WorkspaceLayout from "@/app/(workspace)/layout";
import PortalProfilePage from "@/app/(public)/account/(portal)/profile/page";
import ProfileSignInPage from "@/app/profile/sign-in/page";
import AttendeeSecurityRedirect from "@/app/(public)/account/(portal)/security/page";

const staff = { id: "staff-1", email: "riley@imsda-events.test", displayName: "Riley Staff", globalRole: null };
const attendee = { id: "att-1", verifiedEmail: "pat@imsda-events.test", displayName: "Pat Attendee" };

function signedIn(input: { staff?: typeof staff | null; attendee?: boolean; sessionVia?: "attendee" | "staff" }) {
  mocks.getCurrentSession.mockResolvedValue(input.staff ? { user: input.staff, sessionId: "s1" } : { user: null });
  mocks.getCurrentAttendee.mockResolvedValue(input.attendee
    ? { account: attendee, via: input.sessionVia ?? "attendee", sessionId: "a1" }
    : { account: null, via: null, sessionId: null });
}

/** `/profile`: the staff page, rendered inside the (workspace) layout's shell. */
async function render(query: { twoStep?: string } = {}) {
  return renderToStaticMarkup(await ProfilePage({ searchParams: Promise.resolve(query) }));
}

/** `/account/profile`: the same view inside the attendee portal layout. */
async function renderPortal(query: { twoStep?: string } = {}) {
  return renderToStaticMarkup(await PortalProfilePage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attendeeSecondStepPending.mockResolvedValue(false);
  mocks.requireAttendeeSecondStep.mockResolvedValue(undefined);
  mocks.listDirectedClubs.mockResolvedValue([]);
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.listAccountBannerAnnouncements.mockResolvedValue([]);
  mocks.getMfaStatus.mockResolvedValue({ status: "NONE", required: false });
  mocks.getPasskeySettings.mockResolvedValue({ available: true, passkeys: [], verification: [] });
});

describe("/profile (staff, inside the workspace layout)", () => {
  it("renders the staff account with both managers, with no event and no redirect", async () => {
    signedIn({ staff });
    const markup = await render();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Riley Staff");
    expect(markup).toContain("riley@imsda-events.test");
    expect(markup).toContain("cannot be edited here");
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).toContain('data-manager="staff-passkeys"');
    expect(markup).toContain(">Sign out of staff account<");
    expect(markup).not.toContain("Registration account");
    expect(markup).not.toContain("System management");
    expect(mocks.getMfaStatus).toHaveBeenCalledWith("staff-1");
    expect(mocks.getPasskeySettings).toHaveBeenCalledWith(staff);
  });

  it("does not draw its own shell or portal chrome: the layout above it supplies the shell", async () => {
    signedIn({ staff, attendee: true });
    const markup = await render();
    expect(markup).not.toContain('data-shell="staff"');
    expect(markup).not.toContain("<main");
    expect(markup).not.toContain("System management");
  });

  it("renders both accounts on one page when both sessions are present", async () => {
    signedIn({ staff, attendee: true });
    const markup = await render();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).toContain("Registration account");
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).toContain('data-manager="attendee-settings"');
    expect(markup).toContain('href="/account"');
    expect(markup).toContain("My registrations");
    expect(markup.indexOf('data-manager="staff-mfa"')).toBeLessThan(markup.indexOf("Registration account"));
  });

  it("labels which session each sign-out button ends when both are signed in", async () => {
    signedIn({ staff, attendee: true });
    const markup = await render();
    expect(markup).toContain(">Sign out of staff account<");
    expect(markup).toContain(">Sign out of registration account<");
    signedIn({ staff });
    const staffOnly = await render();
    expect(staffOnly).toContain(">Sign out of staff account<");
    expect(staffOnly).not.toContain("Sign out of registration account");
  });

  it("shows announcements inside the registration card once the second step is passed (#623)", async () => {
    signedIn({ staff, attendee: true });
    mocks.listAccountBannerAnnouncements.mockResolvedValue([{
      id: "ann-2", title: "Synthetic shell notice", body: "Bring a jacket.", priority: "NORMAL",
      pinned: false, eventName: "Synthetic Retreat", href: "/account/events/synthetic-retreat",
    }]);
    const markup = await render();
    expect(markup).toContain("Synthetic shell notice");
    expect(mocks.listAccountBannerAnnouncements).toHaveBeenCalledWith(attendee, []);
  });

  it("shows no banner, and reads no announcements, for a staff-only session or a pending second step (#590)", async () => {
    signedIn({ staff });
    expect(await render()).not.toContain("Announcements");
    signedIn({ staff, attendee: true, sessionVia: "staff" });
    expect(await render()).not.toContain("Announcements");
    signedIn({ staff, attendee: true });
    mocks.attendeeSecondStepPending.mockResolvedValue(true);
    expect(await render()).not.toContain("Announcements");
    expect(mocks.listAccountBannerAnnouncements).not.toHaveBeenCalled();
  });

  it("hides settings, the verified email and announcements while a second step is pending, without redirecting staff", async () => {
    signedIn({ staff, attendee: true });
    mocks.attendeeSecondStepPending.mockResolvedValue(true);
    const markup = await render();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).toContain("Confirm your second step");
    expect(markup).toContain("/account/two-step");
    expect(markup).not.toContain('data-manager="attendee-settings"');
    expect(markup).not.toContain("pat@imsda-events.test");
    expect(markup).toContain("Sign out of registration account");
    expect(mocks.listAccountBannerAnnouncements).not.toHaveBeenCalled();

    mocks.attendeeSecondStepPending.mockResolvedValue(false);
    expect(await render()).toContain("pat@imsda-events.test");
  });

  it("does not treat a staff session that merely matches an attendee email as a registration account", async () => {
    signedIn({ staff, attendee: true, sessionVia: "staff" });
    const markup = await render();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).not.toContain("Registration account");
    expect(markup).toContain('data-manager="staff-mfa"');
  });

  it("confirms two-step verification is on only when an authenticator is really active (#568)", async () => {
    signedIn({ staff, attendee: true });
    attendeePasskeys.mockResolvedValue({ available: true, passkeys: [] });
    attendeeMfaStatus.mockResolvedValue({ status: "ACTIVE" });
    expect(await render({ twoStep: "on" })).toContain("Two-step verification is on.");
    expect(await render()).not.toContain("Two-step verification is on.");
    attendeeMfaStatus.mockResolvedValue({ status: "NONE" });
    expect(await render({ twoStep: "on" })).not.toContain("Two-step verification is on.");
    attendeePasskeys.mockResolvedValue({ available: true, passkeys: [{ id: "pk1" }] });
    expect(await render({ twoStep: "on" })).toContain("Two-step verification is on.");
  });

  it("sends an attendee-only browser to /account/profile, keeping the two-step flag", async () => {
    signedIn({ attendee: true });
    await expect(render()).rejects.toThrow("REDIRECT /account/profile");
    mocks.redirect.mockClear();
    await expect(render({ twoStep: "on" })).rejects.toThrow("REDIRECT /account/profile?twoStep=on");
    expect(mocks.getMfaStatus).not.toHaveBeenCalled();
  });

  it("sends a browser with neither session to the sign-in chooser", async () => {
    signedIn({});
    await expect(render()).rejects.toThrow("REDIRECT /profile/sign-in");
    expect(mocks.getMfaStatus).not.toHaveBeenCalled();
  });
});

describe("/account/profile (attendee, inside the portal layout)", () => {
  it("renders the registration account with no staff sections and no shell of its own", async () => {
    signedIn({ attendee: true });
    const markup = await renderPortal();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Registration account");
    expect(markup).toContain("pat@imsda-events.test");
    expect(markup).toContain('data-manager="attendee-settings"');
    expect(markup).toContain('href="/account"');
    expect(markup).toContain("My registrations");
    expect(markup).toContain(">Sign out of registration account<");
    expect(markup).not.toContain("Sign out of staff account");
    expect(markup).not.toContain('data-shell="staff"');
    expect(markup).not.toContain("<main");
    expect(markup).not.toContain('data-manager="staff-mfa"');
    expect(mocks.getMfaStatus).not.toHaveBeenCalled();
  });

  it("links a club director to their club, or to My clubs for several", async () => {
    signedIn({ attendee: true });
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Pathfinder Test Club", role: "DIRECTOR" }]);
    const one = await renderPortal();
    expect(one).toContain('href="/account/clubs/club-1"');
    expect(one).toContain("Pathfinder Test Club");
    mocks.listDirectedClubs.mockResolvedValue([
      { organizationId: "club-1", name: "Pathfinder Test Club", role: "DIRECTOR" },
      { organizationId: "club-2", name: "Adventurer Test Club", role: "DIRECTOR" },
    ]);
    expect(await renderPortal()).toContain('href="/account/clubs"');
  });

  it("shows both sections when the browser also carries a staff session", async () => {
    signedIn({ staff, attendee: true });
    const markup = await renderPortal();
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).toContain('data-manager="attendee-settings"');
    expect(markup).toContain(">Sign out of staff account<");
    expect(markup).toContain(">Sign out of registration account<");
  });

  it("confirms two-step verification is on only when it really is", async () => {
    signedIn({ attendee: true });
    attendeePasskeys.mockResolvedValue({ available: true, passkeys: [] });
    attendeeMfaStatus.mockResolvedValue({ status: "ACTIVE" });
    expect(await renderPortal({ twoStep: "on" })).toContain("Two-step verification is on.");
    expect(await renderPortal()).not.toContain("Two-step verification is on.");
    attendeeMfaStatus.mockResolvedValue({ status: "PENDING" });
    expect(await renderPortal({ twoStep: "on" })).not.toContain("Two-step verification is on.");
  });

  it("applies the club second step first", async () => {
    signedIn({ attendee: true });
    mocks.requireAttendeeSecondStep.mockImplementation(async () => {
      mocks.redirect("/account/two-step");
    });
    await expect(renderPortal()).rejects.toThrow("REDIRECT /account/two-step");
    expect(mocks.getMfaStatus).not.toHaveBeenCalled();
  });

  it("sends staff with no registration account to /profile, keeping the flag", async () => {
    signedIn({ staff });
    await expect(renderPortal()).rejects.toThrow("REDIRECT /profile");
    mocks.redirect.mockClear();
    signedIn({ staff, attendee: true, sessionVia: "staff" });
    await expect(renderPortal({ twoStep: "on" })).rejects.toThrow("REDIRECT /profile?twoStep=on");
  });

  it("sends a browser with neither session to /profile, which sends it on to the sign-in chooser", async () => {
    signedIn({});
    await expect(renderPortal()).rejects.toThrow("REDIRECT /profile");
  });
});

describe("workspace layout and /profile with no events (#623, #646)", () => {
  async function layoutFor(target: string | null) {
    mocks.headers.mockResolvedValue({ get: () => target });
    return renderToStaticMarkup(await WorkspaceLayout({ children: createElement("p", null, "child") }));
  }

  it("lets any staff account in for /profile only", async () => {
    expect(await layoutFor("/profile")).toContain('data-any-staff="true"');
    expect(await layoutFor("/profile?twoStep=on")).toContain('data-any-staff="true"');
    expect(await layoutFor("/overview")).toContain('data-any-staff="false"');
    expect(await layoutFor("/admin/profile")).toContain('data-any-staff="false"');
    expect(await layoutFor(null)).toContain('data-any-staff="false"');
  });

  it("still renders the shell when the request header cannot be read", async () => {
    mocks.headers.mockRejectedValue(new Error("outside a request"));
    const markup = renderToStaticMarkup(await WorkspaceLayout({ children: createElement("p", null, "child") }));
    expect(markup).toContain('data-shell="staff"');
    expect(markup).toContain('data-any-staff="false"');
  });
});

describe("/profile/sign-in", () => {
  it("offers both sign-ins to a signed-out visitor and reveals nothing about accounts", async () => {
    signedIn({});
    const markup = renderToStaticMarkup(await ProfileSignInPage());
    expect(markup).toContain('href="/account/sign-in"');
    expect(markup).toContain('href="/login?next=%2Fprofile"');
  });

  it("sends anyone already signed in to /profile", async () => {
    signedIn({ staff });
    await expect(ProfileSignInPage()).rejects.toThrow("REDIRECT /profile");
  });
});

describe("old attendee URLs", () => {
  it("/account/security redirects to /account/profile", async () => {
    await expect(AttendeeSecurityRedirect()).rejects.toThrow("REDIRECT /account/profile");
  });

  it("still applies the club second step first", async () => {
    mocks.requireAttendeeSecondStep.mockImplementation(async () => {
      mocks.redirect("/account/two-step");
    });
    await expect(AttendeeSecurityRedirect()).rejects.toThrow("REDIRECT /account/two-step");
  });
});
