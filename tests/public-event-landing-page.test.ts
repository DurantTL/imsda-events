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

import { describePublicEventLifecycle } from "@/modules/events/public-domain";
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
    ended: false,
    heroTagline: "Everything you need to choose the right registration path.",
    formsHeading: "Choose how you’re registering",
    emptyForms: {
      title: "Registration forms are being prepared",
      body: "Event details are available now.",
    },
    availability: { heading: "Registration open", body: "96 spots currently remain." },
    remainingSpots: 96,
  },
  forms: [],
  // The page filters these by kind, so an empty list is the neutral case.
  contentSections: [],
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

describe("public event page without an information URL (#467)", () => {
  it("renders cleanly and drops the 'More information' links rather than an empty one", async () => {
    landingMocks.getPublicEventLanding.mockResolvedValueOnce({
      ...landing,
      links: { ...landing.links, detailsUrl: null },
    });

    const markup = renderToStaticMarkup(await PublicEventPage({
      params: Promise.resolve({ eventSlug: "public-retreat" }),
    }));

    expect(markup).not.toContain("Back to full event details");
    expect(markup).not.toContain("View on imsda.org");
    expect(markup).not.toContain('href=""');
    // The support link is unrelated and must still render.
    expect(markup).toContain("Contact IMSDA");
  });
});

describe("public event extra information", () => {
  it("renders plain-text lines and lists as escaped, scannable blocks", async () => {
    landingMocks.getPublicEventLanding.mockResolvedValueOnce({
      ...landing,
      announcements: [],
      contentSections: [{
        id: "information",
        kind: "RICH_TEXT",
        title: "What to bring",
        body: "Read this first.\n<script>alert('unsafe')</script>\n- Towel\n- Flashlight",
        links: [],
      }],
    });

    const markup = renderToStaticMarkup(await PublicEventPage({
      params: Promise.resolve({ eventSlug: "public-retreat" }),
    }));

    expect(markup).toContain("<p>Read this first.</p>");
    expect(markup).toContain(
      "<p>&lt;script&gt;alert(&#x27;unsafe&#x27;)&lt;/script&gt;</p>",
    );
    expect(markup).toContain("<ul><li>Towel</li><li>Flashlight</li></ul>");
    expect(markup).not.toContain("<script>alert");
  });

  it("keeps resource links guarded and labeled by their visible heading", async () => {
    landingMocks.getPublicEventLanding.mockResolvedValueOnce({
      ...landing,
      announcements: [],
      contentSections: [{
        id: "resources",
        kind: "RESOURCE_LINKS",
        title: "Downloads",
        body: "",
        links: [{
          label: "Packing guide",
          description: "PDF checklist",
          url: "https://example.test/packing.pdf",
          assetId: null,
        }],
      }],
    });

    const markup = renderToStaticMarkup(await PublicEventPage({
      params: Promise.resolve({ eventSlug: "public-retreat" }),
    }));

    expect(markup).toContain('aria-labelledby="public-event-resources-0"');
    expect(markup).toContain('href="https://example.test/packing.pdf"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Packing guide");
    expect(markup).toContain("PDF checklist");
  });
});

describe("public event page for a closed or ended event (#642)", () => {
  it("shows one closed message and no capacity number or 'being prepared' copy", async () => {
    landingMocks.getPublicEventLanding.mockResolvedValueOnce({
      ...landing,
      lifecycle: describePublicEventLifecycle(
        {
          isPublished: true,
          timezone: "America/Chicago",
          capacity: 100,
          registrationOpensOn: "2026-01-01",
          registrationClosesOn: "2026-02-01",
          waitlistEnabled: false,
        },
        40,
        new Date("2026-03-01T18:00:00.000Z"),
      ),
      forms: [],
    });

    const markup = renderToStaticMarkup(await PublicEventPage({
      params: Promise.resolve({ eventSlug: "public-retreat" }),
    }));

    expect(markup).toContain("Registration closed");
    expect(markup).not.toContain("being prepared");
    expect(markup).not.toContain("currently remain");
    expect(markup).not.toContain("spot");
  });
});
