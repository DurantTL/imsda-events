import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const landingMocks = vi.hoisted(() => ({
  getPublicEventLanding: vi.fn(),
}));

vi.mock("@/modules/events/public-repository", () => ({
  getPublicEventLanding: landingMocks.getPublicEventLanding,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

import PublicEventPage from "@/app/(public)/events/[eventSlug]/page";

const landing = {
  event: {
    slug: "public-retreat",
    name: "Public Retreat",
    startsAt: "2026-08-14T21:00:00.000Z",
    endsAt: "2026-08-16T17:00:00.000Z",
    timezone: "America/Chicago",
    location: "Fictitious Conference Center",
    capacity: 100,
    supportContact: "events@example.test",
    dateLabel: "August 14 – 16, 2026",
    timeLabel: "Friday, 4:00 PM CDT – Sunday, 12:00 PM CDT",
  },
  lifecycle: {
    phase: "OPEN",
    state: "OPEN",
    statusLabel: "Registration open",
    detail: "Choose the form that matches your registration.",
    ctaLabel: "Start registration",
    ctaEnabled: true,
    remainingSpots: 96,
  },
  forms: [],
  links: {
    detailsUrl: "https://imsda.org/events/",
    supportUrl: "https://imsda.org/contact/",
  },
  announcements: [{
    id: "announcement-db-id-is-not-public",
    audience: { type: "ALL_ATTENDEES" },
    title: "Arrival information",
    body: "Use the south entrance. <script>alert('unsafe')</script>",
    placement: "HOME_BANNER",
    placementLabel: "Featured notice",
    priority: "IMPORTANT",
    priorityLabel: "Important",
    publishedAt: "2026-07-22T13:30:00.000Z",
    publishedLabel: "Jul 22, 2026, 8:30 AM CDT",
    isFeatured: true,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  landingMocks.getPublicEventLanding.mockResolvedValue(landing);
});

describe("public event landing announcement feed", () => {
  it("renders the calm public projection without internal targeting data", async () => {
    const markup = renderToStaticMarkup(await PublicEventPage({
      params: Promise.resolve({ eventSlug: "public-retreat" }),
    }));

    expect(markup).toContain("Attendee feed");
    expect(markup).toContain("Event updates");
    expect(markup).toContain("Arrival information");
    expect(markup).toContain("Important");
    expect(markup).toContain("Featured notice");
    expect(markup).toContain("Published Jul 22, 2026, 8:30 AM CDT");
    expect(markup).toContain(
      "Use the south entrance. &lt;script&gt;alert(&#x27;unsafe&#x27;)&lt;/script&gt;",
    );
    expect(markup).not.toContain("<script>alert");
    expect(markup).not.toContain("announcement-db-id-is-not-public");
    expect(markup).not.toContain("ALL_ATTENDEES");
  });

  it("does not add an empty attendee-feed panel", async () => {
    landingMocks.getPublicEventLanding.mockResolvedValueOnce({
      ...landing,
      announcements: [],
    });

    const markup = renderToStaticMarkup(await PublicEventPage({
      params: Promise.resolve({ eventSlug: "public-retreat" }),
    }));

    expect(markup).not.toContain("Attendee feed");
    expect(markup).not.toContain("Event updates");
  });
});
