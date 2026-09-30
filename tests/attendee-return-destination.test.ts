import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A signed-out director opening a club page signs in, passes the second step
 * and lands back on that page (#568), and an off-site destination is never
 * followed. Everything is synthetic.
 */

const mocks = vi.hoisted(() => ({
  requestTarget: null as string | null,
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  getRosterAccessStateForPage: vi.fn(),
  getAttendeeRetreatHub: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.requestTarget === null ? {} : { "x-imsda-request-target": mocks.requestTarget }),
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/attendee-accounts/retreat-hub-repository", () => ({
  getAttendeeRetreatHub: mocks.getAttendeeRetreatHub,
  getStaffRetreatHubPreview: vi.fn(),
}));
vi.mock("@/modules/community/repository", () => ({ getAttendeeCommunity: vi.fn(), getStaffCommunity: vi.fn() }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: async () => ({ user: null }) }));
vi.mock("@/components/attendee-community-board", () => ({ AttendeeCommunityBoard: () => null }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ getPasskeySettings: vi.fn(), passkeysConfigured: async () => false }));
vi.mock("@/modules/attendee-accounts/mfa-service", () => ({ getAttendeeMfaStatus: vi.fn() }));
vi.mock("@/components/attendee-sign-out-button", () => ({ AttendeeSignOutButton: () => null }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TwoStepFinished } from "@/components/two-step-setup";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import ClubLayout from "@/app/(public)/account/(portal)/clubs/[organizationId]/layout";
import AttendeeSignInPage from "@/app/(public)/account/sign-in/page";
import EventHubPage from "@/app/(public)/account/events/[eventSlug]/page";
import TwoStepPage from "@/app/(public)/account/two-step/page";
import { config } from "@/proxy";
import {
  attendeeReturnDestination,
  attendeeSignInPathFor,
  twoStepPathFor,
} from "@/modules/attendee-accounts/return-destination";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";

const ROSTER = "/account/clubs/club-1/roster";
const ROSTER_NEXT = encodeURIComponent(ROSTER);

afterEach(() => {
  mocks.requestTarget = null;
  vi.clearAllMocks();
});

describe("attendeeReturnDestination", () => {
  it("accepts account and profile pages, query included", () => {
    expect(attendeeReturnDestination(ROSTER, "/account")).toBe(ROSTER);
    expect(attendeeReturnDestination("/account/clubs?year=2026", "/account")).toBe("/account/clubs?year=2026");
    expect(attendeeReturnDestination("/profile", "/account")).toBe("/profile");
  });

  it("refuses off-site, protocol-relative, encoded, API and other-workspace destinations", () => {
    for (const bad of [
      "https://evil.example/account/clubs",
      "//evil.example/account",
      "/\\evil.example",
      "/account/%2F%2Fevil.example",
      "javascript:alert(1)",
      "/api/attendee/mfa",
      "/admin/team",
      "/accounts-lookalike",
      "/account/../admin",
      "/account/%2e%2e/admin",
      "/account/%2E%2E/admin",
      "/account/./two-step",
      "/account/%2e/two-step",
      "/account/Sign-In",
      "/account/TWO-STEP",
      "",
    ]) {
      expect(attendeeReturnDestination(bad, "/account")).toBe("/account");
    }
    expect(attendeeReturnDestination(undefined, "/account")).toBe("/account");
  });

  it("never returns to a sign-in screen", () => {
    for (const loop of ["/account/sign-in", "/account/sign-in?next=%2Faccount", "/account/two-step", "/account/sign-up", "/profile/sign-in"]) {
      expect(attendeeReturnDestination(loop, "/account")).toBe("/account");
    }
  });

  it("builds sign-in and two-step paths that carry only a safe destination", () => {
    expect(attendeeSignInPathFor(ROSTER)).toBe(`/account/sign-in?next=${ROSTER_NEXT}`);
    expect(twoStepPathFor(ROSTER)).toBe(`/account/two-step?next=${ROSTER_NEXT}`);
    expect(attendeeSignInPathFor("https://evil.example/")).toBe("/account/sign-in");
    expect(twoStepPathFor(null)).toBe("/account/two-step");
  });
});

describe("signed-out director on a club roster", () => {
  it("is sent to sign-in carrying the roster as next", async () => {
    mocks.requestTarget = ROSTER;
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "SIGN_IN" });
    await expect(ClubLayout({ children: null, params: Promise.resolve({ organizationId: "club-1" }) }))
      .rejects.toThrow(`REDIRECT:/account/sign-in?next=${ROSTER_NEXT}`);
  });

  it("after sign-in, a pending second step goes to the challenge carrying the roster", async () => {
    mocks.requestTarget = ROSTER;
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    await expect(requireAttendeeSecondStep()).rejects.toThrow(`REDIRECT:/account/two-step?next=${ROSTER_NEXT}`);
  });

  it("after the challenge, the two-step page lands on the roster, not /account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("OK");
    await expect(TwoStepPage({ searchParams: Promise.resolve({ next: ROSTER }) })).rejects.toThrow(`REDIRECT:${ROSTER}`);
  });

  it("an already signed-in visitor to sign-in with next is sent on to it", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    await expect(AttendeeSignInPage({ searchParams: Promise.resolve({ next: ROSTER }) })).rejects.toThrow(`REDIRECT:${ROSTER}`);
  });
});

describe("an off-site destination is refused", () => {
  it("the two-step page falls back to /account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("OK");
    for (const next of ["https://evil.example/account", "//evil.example", "/api/attendee/mfa"]) {
      await expect(TwoStepPage({ searchParams: Promise.resolve({ next }) })).rejects.toThrow("REDIRECT:/account");
    }
    expect(mocks.redirect).toHaveBeenCalledTimes(3);
    for (const [path] of mocks.redirect.mock.calls) expect(path).toBe("/account");
  });

  it("the sign-in page falls back to /account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    await expect(AttendeeSignInPage({ searchParams: Promise.resolve({ next: "https://evil.example/" }) })).rejects.toThrow("REDIRECT:/account");
  });

  it("a forged request-target header is not reflected into the sign-in URL", async () => {
    mocks.requestTarget = "https://evil.example/account";
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "SIGN_IN" });
    await expect(ClubLayout({ children: null, params: Promise.resolve({ organizationId: "club-1" }) }))
      .rejects.toThrow("REDIRECT:/account/sign-in");
    expect(mocks.redirect).toHaveBeenLastCalledWith("/account/sign-in");
  });
});

describe("two-step page edge cases", () => {
  it("with no account redirects to sign-in carrying next", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    await expect(TwoStepPage({ searchParams: Promise.resolve({ next: ROSTER }) }))
      .rejects.toThrow(`REDIRECT:/account/sign-in?next=${ROSTER_NEXT}`);
  });

  it("refuses a repeated (array) next and falls back to /account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("OK");
    await expect(TwoStepPage({ searchParams: Promise.resolve({ next: [ROSTER, "https://evil.example/"] }) }))
      .rejects.toThrow("REDIRECT:/account");
    expect(mocks.redirect).toHaveBeenLastCalledWith("/account");
    await expect(AttendeeSignInPage({ searchParams: Promise.resolve({ next: [ROSTER, ROSTER] }) }))
      .rejects.toThrow("REDIRECT:/account");
    expect(mocks.redirect).toHaveBeenLastCalledWith("/account");
  });
});

describe("second step still owed", () => {
  const hubProps = { params: Promise.resolve({ eventSlug: "retreat" }), searchParams: Promise.resolve({}) };

  it("Google sign-in landing (a carried next) goes to /account/two-step?next=...", async () => {
    // The Google callback lands on next; the club layout then sends the pending step on.
    mocks.requestTarget = ROSTER;
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    await expect(requireAttendeeSecondStep()).rejects.toThrow(`REDIRECT:/account/two-step?next=${ROSTER_NEXT}`);
  });

  it("the event hub sends an owed second step to the challenge, carrying the hub", async () => {
    mocks.requestTarget = "/account/events/retreat";
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1", verifiedEmail: "p@example.test" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    await expect(EventHubPage(hubProps)).rejects.toThrow(`REDIRECT:/account/two-step?next=${encodeURIComponent("/account/events/retreat")}`);
    expect(mocks.getAttendeeRetreatHub).not.toHaveBeenCalled();
  });

  it("the event hub sends a signed-out visitor to sign-in carrying the hub", async () => {
    mocks.requestTarget = "/account/events/retreat";
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    await expect(EventHubPage(hubProps)).rejects.toThrow(`REDIRECT:/account/sign-in?next=${encodeURIComponent("/account/events/retreat")}`);
  });

  it("the event hub still loads once the second step is passed", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "a1", verifiedEmail: "p@example.test" }, via: "attendee", sessionId: "s1" });
    mocks.accountNeedsSecondStep.mockResolvedValue("OK");
    mocks.getAttendeeRetreatHub.mockResolvedValue(null);
    await expect(EventHubPage(hubProps)).rejects.toThrow("NOT_FOUND");
    expect(mocks.getAttendeeRetreatHub).toHaveBeenCalled();
  });
});

describe("setup finish card", () => {
  it("says two-step verification is on and links to next, else /profile", () => {
    for (const [next, href] of [[ROSTER, ROSTER], [undefined, "/account/profile?twoStep=on"]] as const) {
      const markup = renderToStaticMarkup(createElement(TwoStepFinished, { next }));
      expect(markup).toContain("Two-step verification is on.");
      expect(markup).toContain(`href="${href}"`);
    }
  });
});

describe("proxy coverage", () => {
  it("records the request target for account pages", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: ROSTER })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/attendee/mfa" })).toBe(false);
  });
});
