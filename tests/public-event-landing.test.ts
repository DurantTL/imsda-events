import { describe, expect, it } from "vitest";
import {
  buildPublicEventAnnouncementFeed,
  describePublicEventLifecycle,
  formatPublicEventSchedule,
  publicEventWebsiteLinks,
  summarizePublicRegistrationForm,
} from "@/modules/events/public-domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const baseEvent = {
  isPublished: true,
  timezone: "America/Chicago",
  capacity: 100,
  registrationOpensOn: "2026-08-01",
  registrationClosesOn: "2026-09-30",
  waitlistEnabled: true,
};

describe("public event landing domain", () => {
  it("describes upcoming, open, closed, full, and waitlist states", () => {
    expect(describePublicEventLifecycle(
      baseEvent,
      10,
      new Date("2026-07-31T18:00:00.000Z"),
    )).toMatchObject({
      state: "UPCOMING",
      ctaEnabled: false,
      statusLabel: "Registration opens August 1, 2026",
    });

    expect(describePublicEventLifecycle(
      baseEvent,
      99,
      new Date("2026-08-01T18:00:00.000Z"),
    )).toMatchObject({
      state: "OPEN",
      ctaEnabled: true,
      remainingSpots: 1,
    });

    expect(describePublicEventLifecycle(
      baseEvent,
      100,
      new Date("2026-08-01T18:00:00.000Z"),
    )).toMatchObject({
      state: "WAITLIST",
      ctaLabel: "Join the waitlist",
      ctaEnabled: true,
    });

    expect(describePublicEventLifecycle(
      { ...baseEvent, waitlistEnabled: false },
      100,
      new Date("2026-08-01T18:00:00.000Z"),
    )).toMatchObject({
      state: "FULL",
      ctaEnabled: false,
    });

    expect(describePublicEventLifecycle(
      baseEvent,
      80,
      new Date("2026-10-01T18:00:00.000Z"),
    )).toMatchObject({
      state: "CLOSED",
      ctaEnabled: false,
    });
  });

  it("turns a published definition into a friendly registration choice", () => {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Household retreat registration",
      description: "Register everyone attending from your household.",
      confirmationMessage: "Registration received.",
      attendeeRoster: {
        enabled: true,
        minAttendees: 1,
        maxAttendees: 6,
        attendeeLabel: "Guest",
        addButtonLabel: "Add another guest",
      },
      payment: {
        enabled: true,
        currency: "USD",
        paymentMethodFieldKey: "payment_method",
        cardOptionValue: "Card",
        percentageBasisPoints: 290,
        fixedFeeCents: 30,
        passFeeToRegistrant: true,
      },
      sections: [{
        id: "attendees",
        title: "Guests",
        description: "",
        fields: [
          { id: "first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "email_address", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
          { id: "payment_choice", key: "payment_method", label: "Payment method", helpText: "", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Pay later", "Card"] },
        ],
      }],
    });

    expect(summarizePublicRegistrationForm(definition)).toEqual({
      title: "Household retreat registration",
      description: "Register everyone attending from your household.",
      audienceLabel: "Guest roster",
      highlights: ["Add up to 6 guests", "1 section", "Includes fee calculation"],
    });
  });

  it("formats the event schedule in the event timezone", () => {
    expect(formatPublicEventSchedule(
      new Date("2026-10-09T21:00:00.000Z"),
      new Date("2026-10-11T17:00:00.000Z"),
      "America/Chicago",
    )).toEqual({
      dateLabel: "October 9 – 11, 2026",
      timeLabel: "Friday, 4:00 PM CDT – Sunday, 12:00 PM CDT",
    });
  });

  it("uses the known event page and safe site-wide fallbacks", () => {
    expect(publicEventWebsiteLinks("womens-retreat-2026")).toEqual({
      detailsUrl: "https://imsda.org/event/womens-retreat-3/",
      supportUrl: "https://imsda.org/contact/",
    });
    expect(publicEventWebsiteLinks("womens-retreat-2026", "https://imsda.org/custom-event/").detailsUrl)
      .toBe("https://imsda.org/custom-event/");
    expect(publicEventWebsiteLinks("another-event").detailsUrl).toBe("https://imsda.org/events/");
  });

  it("projects only already-published exact all-attendee announcements", () => {
    const now = new Date("2026-07-23T18:00:00.000Z");
    const candidate = {
      body: "Use the south entrance for event check-in.",
      audience: { type: "ALL_ATTENDEES" },
      placement: "HOME_BANNER",
      status: "PUBLISHED",
      priority: "IMPORTANT" as const,
      publishedAt: new Date("2026-07-22T13:30:00.000Z"),
    };
    const feed = buildPublicEventAnnouncementFeed([
      { ...candidate, title: "Arrival information" },
      {
        ...candidate,
        title: "Urgent weather update",
        priority: "URGENT",
        placement: "EVENT_FEED",
        publishedAt: new Date("2026-07-21T13:30:00.000Z"),
      },
      { ...candidate, title: "Staff draft", status: "DRAFT" },
      { ...candidate, title: "Archived update", status: "ARCHIVED" },
      {
        ...candidate,
        title: "Scheduled update",
        status: "SCHEDULED",
        publishedAt: new Date("2026-07-22T13:30:00.000Z"),
      },
      {
        ...candidate,
        title: "Future publication",
        publishedAt: new Date("2026-07-24T13:30:00.000Z"),
      },
      {
        ...candidate,
        title: "Targeted update",
        audience: { type: "REGISTRATION_STATUS", statuses: ["CONFIRMED"] },
      },
      {
        ...candidate,
        title: "Audience with extra selector",
        audience: { type: "ALL_ATTENDEES", internalTag: "staff-only" },
      },
    ], "America/Chicago", now);

    expect(feed.map((announcement) => announcement.title)).toEqual([
      "Urgent weather update",
      "Arrival information",
    ]);
    expect(feed[1]).toEqual({
      title: "Arrival information",
      body: "Use the south entrance for event check-in.",
      placement: "HOME_BANNER",
      placementLabel: "Featured notice",
      priority: "IMPORTANT",
      priorityLabel: "Important",
      publishedAt: "2026-07-22T13:30:00.000Z",
      publishedLabel: "Jul 22, 2026, 8:30 AM CDT",
      isFeatured: true,
    });
    expect(JSON.stringify(feed)).not.toContain("audience");
    expect(JSON.stringify(feed)).not.toContain("status");
    expect(JSON.stringify(feed)).not.toContain("internalTag");
  });
});
