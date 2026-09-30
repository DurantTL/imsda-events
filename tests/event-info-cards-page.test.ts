import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicEventLanding: vi.fn(),
  getAutoEventInfoCards: vi.fn(),
}));

vi.mock("@/modules/events/public-repository", () => ({
  getPublicEventLanding: mocks.getPublicEventLanding,
}));
vi.mock("@/modules/event-info-cards/repository", () => ({
  getAutoEventInfoCards: mocks.getAutoEventInfoCards,
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

import PublicEventPage from "@/app/(public)/events/[eventSlug]/page";
import { buildEventInfoCards } from "@/modules/event-info-cards/domain";

const landing = (audience: "GENERAL" | "CLUB") => ({
  event: {
    slug: "synthetic-event",
    name: "Synthetic Event",
    startsAt: "2026-11-06T15:00:00.000Z",
    endsAt: "2026-11-08T18:00:00.000Z",
    timezone: "America/Chicago",
    location: "Synthetic Camp",
    capacity: null,
    supportContact: "events@example.test",
    audience,
    dateLabel: "November 6 – 8, 2026",
    timeLabel: "Friday, 9:00 AM CST – Sunday, 12:00 PM CST",
  },
  lifecycle: {
    phase: "OPEN",
    state: "OPEN",
    statusLabel: "Registration open",
    detail: "Choose the form that matches your registration.",
    ctaLabel: "Start registration",
    ctaEnabled: true,
    ended: false,
    heroTagline: "Everything you need to choose the right registration path.",
    formsHeading: "Choose how you are registering",
    emptyForms: { title: "Registration forms are being prepared", body: "Event details are available now." },
    availability: { heading: "Registration open", body: "Spots remain." },
    remainingSpots: null,
  },
  forms: [],
  contentSections: [],
  links: { detailsUrl: null, supportUrl: "https://imsda.org/contact/" },
  announcements: [],
});

const cards = buildEventInfoCards({
  event: {
    name: "Synthetic Event",
    location: "Synthetic Camp",
    dateLabel: "November 6 – 8, 2026",
    tagline: "Synthetic Theme",
    subtitle: "One form for your whole club",
    helpEmail: null,
    audience: "CLUB",
    billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    registrationClosesOn: "2026-10-30",
  },
  locations: [],
  sessions: [],
  offerings: [],
  forms: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAutoEventInfoCards.mockResolvedValue(cards);
});

const render = async () => renderToStaticMarkup(await PublicEventPage({
  params: Promise.resolve({ eventSlug: "synthetic-event" }),
}));

describe("auto info cards on the public event page", () => {
  it("shows the header and cards for a club event", async () => {
    mocks.getPublicEventLanding.mockResolvedValue(landing("CLUB"));
    const markup = await render();
    expect(mocks.getAutoEventInfoCards).toHaveBeenCalledWith("synthetic-event");
    expect(markup).toContain("Iowa-Missouri Conference of Seventh-day Adventists");
    expect(markup).toContain("Synthetic Theme");
    expect(markup).toContain("One form for your whole club");
    expect(markup).toContain("Registration deadlines");
    expect(markup).toContain("youth@imsda.org");
  });

  it("leaves a general event page unchanged and never reads card data", async () => {
    mocks.getPublicEventLanding.mockResolvedValue(landing("GENERAL"));
    const markup = await render();
    expect(mocks.getAutoEventInfoCards).not.toHaveBeenCalled();
    expect(markup).toContain("Iowa-Missouri Conference event");
    expect(markup).not.toContain("auto-info");
    expect(markup).not.toContain("Registration deadlines");
  });
});
