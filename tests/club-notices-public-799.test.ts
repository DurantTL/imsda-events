import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Club-audience notices on the public pages of a published club event (#799 G7, G8).
const mocks = vi.hoisted(() => ({
  eventFindFirst: vi.fn(),
  getPublicRegistrationExperience: vi.fn(),
  getAutoEventInfoCards: vi.fn(),
  listPublishedRegistrationInfoCards: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findFirst: mocks.eventFindFirst },
    eventContentSection: { findMany: vi.fn().mockResolvedValue([]) },
    registrationAttendee: { count: vi.fn().mockResolvedValue(0) },
  }),
}));
vi.mock("@/modules/event-info-cards/repository", () => ({ getAutoEventInfoCards: mocks.getAutoEventInfoCards }));
vi.mock("@/modules/forms/public-repository", () => ({ getPublicRegistrationExperience: mocks.getPublicRegistrationExperience }));
vi.mock("@/modules/events/content-repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/events/content-repository")>()),
  listPublishedRegistrationInfoCards: mocks.listPublishedRegistrationInfoCards,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: vi.fn().mockResolvedValue({ account: null, via: null }) }));
vi.mock("@/modules/attendee-accounts/profile-service", () => ({ attendeeProfilePrefill: vi.fn(), getAttendeeProfile: vi.fn(), withoutPersonalDetails: vi.fn() }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: vi.fn().mockResolvedValue(false) }));
// The stub renders topContent first, like the real form column; the real form's own copy is not what is under test here.
vi.mock("@/components/public-registration-form", () => ({
  PublicRegistrationForm: (props: { topContent?: unknown }) => createElement("div", null, props.topContent as never, "REGISTRATION-FORM-STUB"),
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }), redirect: vi.fn() }));

import { getFormTemplate } from "@/modules/forms/definition";
import { buildEventInfoCards } from "@/modules/event-info-cards/domain";
import {
  CLUB_DIRECTOR_SIGN_IN_BUTTON,
  CLUB_DIRECTOR_SIGN_IN_TITLE,
  CLUB_ONLY_NOTICES,
  clubDirectorSignInNotice,
} from "@/modules/club-registrations/club-notices";
import { CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE } from "@/modules/club-registrations/entry-path";

const SLUG = "synthetic-honors-weekend";

function clubEventRow(overrides: Record<string, unknown> = {}) {
  const template = getFormTemplate("honors_weekend");
  if (!template) throw new Error("honors_weekend template missing");
  return {
    id: "event-synthetic",
    slug: SLUG,
    name: "Synthetic Honors Weekend",
    startsAt: new Date("2027-03-12T22:00:00.000Z"),
    endsAt: new Date("2027-03-14T17:00:00.000Z"),
    timezone: "America/Chicago",
    location: "Fictitious Camp",
    capacity: 300,
    publicInfoUrl: null,
    supportContact: "events@example.test",
    audience: "CLUB",
    isPublished: true,
    registrationOpensOn: null,
    registrationClosesOn: null,
    waitlistEnabled: true,
    billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    announcements: [],
    registrationForms: [{
      id: "form-1",
      name: "Club roster",
      slug: "club-roster",
      createdAt: new Date("2027-01-01"),
      versions: [{ id: "form-1-v1", versionNumber: 1, status: "PUBLISHED", definition: structuredClone(template.definition) }],
    }],
    ...overrides,
  };
}

async function landingMarkup(row: ReturnType<typeof clubEventRow>) {
  mocks.eventFindFirst.mockResolvedValue(row);
  vi.resetModules();
  const { default: Page } = await import("@/app/(public)/events/[eventSlug]/page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ eventSlug: SLUG }) }));
}

async function registrationMarkup(audience: "CLUB" | "GENERAL") {
  mocks.getPublicRegistrationExperience.mockResolvedValue({
    event: { name: "Synthetic Honors Weekend", slug: SLUG, audience, startsAt: new Date("2027-03-12T22:00:00Z"), endsAt: new Date("2027-03-14T17:00:00Z") },
    lifecycle: { phase: "OPEN", capacityDecision: "OPEN" },
    form: { definition: { sections: [] } },
    choiceUsage: {},
    pricingDate: "2027-01-01",
  });
  vi.resetModules();
  const { default: Page } = await import("@/app/(public)/register/[eventSlug]/[formSlug]/page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ eventSlug: SLUG, formSlug: "club-roster" }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPublishedRegistrationInfoCards.mockResolvedValue([]);
  mocks.getAutoEventInfoCards.mockResolvedValue(buildEventInfoCards({
    event: {
      name: "Synthetic Honors Weekend", location: null, dateLabel: "March 12 – 14, 2027", tagline: null, subtitle: null, helpEmail: null,
      audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", registrationClosesOn: "2027-03-01",
      startsAt: new Date("2027-03-12T22:00:00Z"), endsAt: new Date("2027-03-14T17:00:00Z"), timezone: "America/Chicago",
    },
    locations: [], sessions: [], offerings: [], forms: [],
  }));
});

describe("no club-only notice renders on a published club event's public pages (G7)", () => {
  it("keeps every signed-in club notice off the public event page", async () => {
    const markup = await landingMarkup(clubEventRow());
    for (const notice of CLUB_ONLY_NOTICES) expect(markup, notice).not.toContain(notice);
    // A director who is not signed in is never told they lack a club role.
    expect(markup).not.toContain(CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE);
  });

  it("keeps every signed-in club notice off the public registration page", async () => {
    const markup = await registrationMarkup("CLUB");
    for (const notice of CLUB_ONLY_NOTICES) expect(markup, notice).not.toContain(notice);
  });

  it("lists the club-only wording, so the guard cannot quietly become empty", () => {
    expect(CLUB_ONLY_NOTICES.length).toBeGreaterThanOrEqual(5);
    expect(CLUB_ONLY_NOTICES).toContain(CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE);
  });
});

describe("the club-director sign-in notice (G8)", () => {
  it("is built only for a club event, and points at the signed-in club door", () => {
    expect(clubDirectorSignInNotice({ audience: "GENERAL", slug: SLUG })).toBeNull();
    expect(clubDirectorSignInNotice({ audience: "CLUB", slug: SLUG })?.href).toBe(`/account/club-registration/${SLUG}`);
  });

  it("is a callout with a heading, an icon, and a sign-in button near the top of the public event page", async () => {
    const markup = await landingMarkup(clubEventRow());
    expect(markup).toContain('data-testid="club-director-sign-in-notice"');
    expect(markup).toContain(CLUB_DIRECTOR_SIGN_IN_TITLE);
    expect(markup).toContain(`href="/account/club-registration/${SLUG}"`);
    expect(markup).toContain(CLUB_DIRECTOR_SIGN_IN_BUTTON);
    expect(markup).toContain("<svg");
    // Above the registration options, not buried below them.
    expect(markup.indexOf("club-director-sign-in-notice")).toBeLessThan(markup.indexOf("registration-options-title"));
  });

  it("sits above the form on the public registration page of a club event", async () => {
    const markup = await registrationMarkup("CLUB");
    expect(markup).toContain(CLUB_DIRECTOR_SIGN_IN_TITLE);
    expect(markup).toContain(`href="/account/club-registration/${SLUG}"`);
    expect(markup.indexOf(CLUB_DIRECTOR_SIGN_IN_TITLE)).toBeLessThan(markup.indexOf("REGISTRATION-FORM-STUB"));
  });

  it("does not appear on a general event", async () => {
    mocks.getAutoEventInfoCards.mockResolvedValue(null);
    const registration = await registrationMarkup("GENERAL");
    expect(registration).not.toContain(CLUB_DIRECTOR_SIGN_IN_TITLE);
    const landing = await landingMarkup(clubEventRow({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" }));
    expect(landing).not.toContain(CLUB_DIRECTOR_SIGN_IN_TITLE);
  });
});
