import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicRegistrationExperience: vi.fn(),
  getAutoEventInfoCards: vi.fn(),
  eventFindFirst: vi.fn(),
  formProps: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/forms/public-repository", () => ({
  getPublicRegistrationExperience: mocks.getPublicRegistrationExperience,
}));
vi.mock("@/modules/event-info-cards/repository", () => ({
  getAutoEventInfoCards: mocks.getAutoEventInfoCards,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: vi.fn().mockResolvedValue({ account: null }),
}));
vi.mock("@/modules/attendee-accounts/profile-service", () => ({
  attendeeProfilePrefill: vi.fn(),
  getAttendeeProfile: vi.fn(),
}));
// The stub renders topContent first, then a marker, like the real form column.
vi.mock("@/components/public-registration-form", () => ({
  PublicRegistrationForm: (props: { topContent?: unknown }) => {
    mocks.formProps(props);
    return createElement("div", null, props.topContent as never, "REGISTRATION-FORM-STUB");
  },
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));

import RegisterPage from "@/app/(public)/register/[eventSlug]/[formSlug]/page";
import { buildEventInfoCards } from "@/modules/event-info-cards/domain";

const experience = {
  event: { name: "Synthetic Event", slug: "synthetic-event", startsAt: new Date("2026-11-06T15:00:00Z"), endsAt: new Date("2026-11-08T18:00:00Z") },
  lifecycle: { phase: "OPEN", capacityDecision: "OPEN" },
  form: { definition: { sections: [] } },
  choiceUsage: {},
  pricingDate: "2026-10-01",
};

const cards = buildEventInfoCards({
  event: {
    name: "Synthetic Event", location: null, dateLabel: "November 6 – 8, 2026", tagline: null, subtitle: null, helpEmail: null,
    audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", registrationClosesOn: "2026-10-30",
    startsAt: new Date("2026-11-06T15:00:00Z"), endsAt: new Date("2026-11-08T18:00:00Z"), timezone: "America/Chicago",
  },
  locations: [], sessions: [], offerings: [], forms: [],
});

const render = async () => renderToStaticMarkup(await RegisterPage({
  params: Promise.resolve({ eventSlug: "synthetic-event", formSlug: "club" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicRegistrationExperience.mockResolvedValue(experience);
});

describe("auto info cards on the registration page", () => {
  it("puts the cards above the form for a club event", async () => {
    mocks.getAutoEventInfoCards.mockResolvedValue(cards);
    const markup = await render();
    expect(markup).toContain("Registration deadlines");
    expect(markup.indexOf("Registration deadlines")).toBeLessThan(markup.indexOf("REGISTRATION-FORM-STUB"));
    // The cards reach the form through topContent, inside its layout.
    expect(mocks.formProps.mock.calls[0]![0].topContent).toBeTruthy();
  });

  it("renders only the form for any other event", async () => {
    mocks.getAutoEventInfoCards.mockResolvedValue(null);
    const markup = await render();
    expect(markup).toBe("<div>REGISTRATION-FORM-STUB</div>");
    expect(mocks.formProps.mock.calls[0]![0].topContent).toBeUndefined();
  });
});

describe("the card repository only serves club events", () => {
  it("filters the event query by CLUB audience and returns null for no match", async () => {
    vi.resetModules();
    vi.doUnmock("@/modules/event-info-cards/repository");
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => ({ event: { findFirst: mocks.eventFindFirst } }) }));
    mocks.eventFindFirst.mockResolvedValue(null);
    const { getAutoEventInfoCards } = await import("@/modules/event-info-cards/repository");
    await expect(getAutoEventInfoCards("general-event")).resolves.toBeNull();
    expect(mocks.eventFindFirst.mock.calls[0]![0].where).toMatchObject({ slug: "general-event", isPublished: true, audience: "CLUB" });
  });
});
