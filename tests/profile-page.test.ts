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
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({
  attendeeSecondStepPending: mocks.attendeeSecondStepPending,
  requireAttendeeSecondStep: mocks.requireAttendeeSecondStep,
}));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
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
vi.mock("@/components/act-as-banner", () => ({
  ActAsBanner: (props: { acting: unknown }) => (props.acting ? createElement("aside", null, "ACT-AS-BANNER") : null),
}));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));

import ProfilePage from "@/app/profile/page";
import ProfileSignInPage from "@/app/profile/sign-in/page";
import AttendeeProfileRedirect from "@/app/(public)/account/(portal)/profile/page";
import AttendeeSecurityRedirect from "@/app/(public)/account/(portal)/security/page";

const staff = { id: "staff-1", email: "riley@imsda-events.test", displayName: "Riley Staff", globalRole: null };
const admin = { ...staff, id: "admin-1", email: "casey@imsda-events.test", displayName: "Casey Admin", globalRole: "SYSTEM_ADMIN" };
const attendee = { id: "att-1", verifiedEmail: "pat@imsda-events.test", displayName: "Pat Attendee" };

function signedIn(input: { staff?: typeof staff | typeof admin | null; attendee?: boolean; sessionVia?: "attendee" | "staff" }) {
  mocks.getCurrentSession.mockResolvedValue(input.staff ? { user: input.staff, sessionId: "s1" } : { user: null });
  mocks.getCurrentAttendee.mockResolvedValue(input.attendee
    ? { account: attendee, via: input.sessionVia ?? "attendee", sessionId: "a1" }
    : { account: null, via: null, sessionId: null });
}

async function render() {
  return renderToStaticMarkup(await ProfilePage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attendeeSecondStepPending.mockResolvedValue(false);
  mocks.requireAttendeeSecondStep.mockResolvedValue(undefined);
  mocks.listDirectedClubs.mockResolvedValue([]);
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.getMfaStatus.mockResolvedValue({ status: "NONE", required: false });
  mocks.getPasskeySettings.mockResolvedValue({ available: true, passkeys: [], verification: [] });
});

describe("/profile", () => {
  it("renders the staff account with both managers, with no event and no redirect", async () => {
    signedIn({ staff });
    const markup = await render();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Staff account");
    expect(markup).toContain("Riley Staff");
    expect(markup).toContain("riley@imsda-events.test");
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).toContain('data-manager="staff-passkeys"');
    expect(markup).toContain("Back to staff workspace");
    expect(markup).toContain('href="/overview"');
    expect(markup).not.toContain("Registration account");
    expect(markup).not.toContain("System management");
    expect(mocks.getMfaStatus).toHaveBeenCalledWith("staff-1");
    expect(mocks.getPasskeySettings).toHaveBeenCalledWith(staff);
  });

  it("links administrators to System management", async () => {
    signedIn({ staff: admin });
    const markup = await render();
    expect(markup).toContain("System management");
    expect(markup).toContain('href="/admin"');
  });

  it("renders only the registration account for an attendee", async () => {
    signedIn({ attendee: true });
    const markup = await render();
    expect(markup).toContain("Registration account");
    expect(markup).toContain("pat@imsda-events.test");
    expect(markup).toContain('data-manager="attendee-settings"');
    expect(markup).toContain('href="/account"');
    expect(markup).toContain("My registrations");
    expect(markup).not.toContain("Staff account");
    expect(markup).not.toContain('data-manager="staff-mfa"');
    expect(markup).not.toContain("Back to staff workspace");
    expect(mocks.getMfaStatus).not.toHaveBeenCalled();
  });

  it("links a club director to their club", async () => {
    signedIn({ attendee: true });
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Pathfinder Test Club", role: "DIRECTOR" }]);
    const markup = await render();
    expect(markup).toContain('href="/account/clubs/club-1"');
    expect(markup).toContain("Pathfinder Test Club");
  });

  it("shows both labelled sections when both sessions are present", async () => {
    signedIn({ staff, attendee: true });
    const markup = await render();
    expect(markup).toContain("Staff account");
    expect(markup).toContain("Registration account");
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).toContain('data-manager="attendee-settings"');
    expect(markup).toContain("Back to staff workspace");
    expect(markup).toContain("My registrations");
  });

  it("labels which session each sign-out button ends when both are signed in", async () => {
    signedIn({ staff, attendee: true });
    const markup = await render();
    expect(markup).toContain(">Sign out of staff account<");
    expect(markup).toContain(">Sign out of registration account<");
    expect(markup.indexOf("Sign out of staff account")).toBeLessThan(markup.indexOf("Registration account"));
    signedIn({ staff });
    expect(await render()).toContain(">Sign out of staff account<");
    signedIn({ attendee: true });
    const attendeeOnly = await render();
    expect(attendeeOnly).toContain(">Sign out of registration account<");
    expect(attendeeOnly).not.toContain("Sign out of staff account");
  });

  it("shows the act-as banner only when a staff act-as context is active", async () => {
    signedIn({ staff });
    expect(await render()).not.toContain("ACT-AS-BANNER");
    mocks.currentStaffActingContext.mockResolvedValue({ role: "CLUB_DIRECTOR" });
    expect(await render()).toContain("ACT-AS-BANNER");
    signedIn({ attendee: true });
    expect(await render()).not.toContain("ACT-AS-BANNER");
  });

  it("does not treat a staff session that merely matches an attendee email as a registration account", async () => {
    signedIn({ staff, attendee: true, sessionVia: "staff" });
    const markup = await render();
    expect(markup).toContain("Staff account");
    expect(markup).not.toContain("Registration account");
  });

  it("sends an attendee with a pending second step to /account/two-step, but keeps staff on the page", async () => {
    signedIn({ attendee: true });
    mocks.attendeeSecondStepPending.mockResolvedValue(true);
    await expect(render()).rejects.toThrow("REDIRECT /account/two-step");

    mocks.redirect.mockClear();
    signedIn({ staff, attendee: true });
    const markup = await render();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(markup).toContain('data-manager="staff-mfa"');
    expect(markup).not.toContain('data-manager="attendee-settings"');
    expect(markup).toContain("/account/two-step");
    // The verified email stays hidden until the second step is passed.
    expect(markup).not.toContain("pat@imsda-events.test");
    expect(markup).toContain("Sign out of registration account");

    mocks.attendeeSecondStepPending.mockResolvedValue(false);
    expect(await render()).toContain("pat@imsda-events.test");
  });

  it("redirects a signed-out visitor to the sign-in chooser", async () => {
    signedIn({});
    await expect(render()).rejects.toThrow("REDIRECT /profile/sign-in");
    expect(mocks.getMfaStatus).not.toHaveBeenCalled();
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
  it.each([
    ["/account/profile", () => AttendeeProfileRedirect()],
    ["/account/security", () => AttendeeSecurityRedirect()],
  ])("%s redirects to /profile", async (_path, page) => {
    await expect(page()).rejects.toThrow("REDIRECT /profile");
  });

  it("still applies the club second step first", async () => {
    mocks.requireAttendeeSecondStep.mockImplementation(async () => {
      mocks.redirect("/account/two-step");
    });
    await expect(AttendeeSecurityRedirect()).rejects.toThrow("REDIRECT /account/two-step");
  });
});
