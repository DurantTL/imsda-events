import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** Public states and sign-in wording (#688). Synthetic data only. */

const mocks = vi.hoisted(() => ({
  getGroupRegistrationExperience: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/modules/group-registrations/repository", () => ({
  GroupRegistrationError: class extends Error { code = "EVENT_NOT_FOUND"; },
  getGroupRegistrationExperience: mocks.getGroupRegistrationExperience,
}));
vi.mock("@/modules/events/content-repository", () => ({ listPublishedRegistrationInfoCards: vi.fn(async () => []) }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: async () => ({ account: null }) }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: async () => false }));
vi.mock("@/integrations/oauth/google", () => ({ isGoogleSignInConfigured: () => false }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: async () => ({ user: null }) }));
vi.mock("@/modules/calendar/repository", () => ({
  conferenceToday: () => "2026-10-05",
  listPublicCalendarItems: async () => [],
}));

import AttendeeSignInPage, { metadata as signInMetadata } from "@/app/(public)/account/sign-in/page";
import PublicCalendarPage from "@/app/(public)/calendar/page";
import GroupRegistrationPage from "@/app/(public)/register/[eventSlug]/group/page";
import ProfileSignInPage from "@/app/profile/sign-in/page";

describe("sign-in wording", () => {
  it("the account sign-in page is headed Account sign in, for registrations and clubs alike", async () => {
    const markup = renderToStaticMarkup(await AttendeeSignInPage({ searchParams: Promise.resolve({}) }));
    expect(markup).toContain("<h1>Account sign in</h1>");
    expect(markup).not.toContain("Registrant");
    expect(signInMetadata.title).toBe("Account sign in");
  });

  it("the profile chooser names both doors", async () => {
    const markup = renderToStaticMarkup(await ProfileSignInPage());
    expect(markup).toContain("Account sign in (registrations and clubs)");
    expect(markup).toContain("Staff sign in");
  });
});

describe("group registration not-available state", () => {
  it("renders the site header, the gutter card, and Group wording", async () => {
    mocks.getGroupRegistrationExperience.mockResolvedValue({ problem: "not configured", event: null, experience: null });
    const markup = renderToStaticMarkup(await GroupRegistrationPage({ params: Promise.resolve({ eventSlug: "synthetic-weekend" }) }));
    expect(markup).toContain("public-registration-header");
    expect(markup).toContain("public-group-state");
    expect(markup).not.toContain("style=");
    expect(markup).toContain("Group registration isn&#x27;t available yet");
    expect(markup).toContain("/events/synthetic-weekend");
  });
});

describe("calendar subscribe link", () => {
  it("has an accessible name even when its text is hidden on phones", async () => {
    const markup = renderToStaticMarkup(await PublicCalendarPage({ searchParams: Promise.resolve({}) }));
    const link = markup.match(/<a[^>]*href="\/calendar\/feed\.ics"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('aria-label="Subscribe to the calendar"');
  });
});
