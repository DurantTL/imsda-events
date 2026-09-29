import { describe, expect, it } from "vitest";
import {
  buildLocationWaitlistDigest,
  centralDateKey,
  centralInstant,
  digestCount,
  digestIdempotencyKey,
  digestWindow,
  type DigestEventSection,
} from "@/modules/event-locations/waitlist-digest-domain";

/**
 * The daily location waitlist digest (#599): when it is due (morning, Central
 * time), what it says, and the key that keeps it to one email per person per
 * day. Synthetic names only.
 */

describe("the digest schedule", () => {
  it("is not due before the morning send time in Central time, and is from then on", () => {
    // 6:59 AM CDT (UTC-5) on 2026-10-06 is 11:59 UTC; 7:00 AM is 12:00 UTC.
    expect(digestWindow(new Date("2026-10-06T11:59:00Z"))).toMatchObject({ dateKey: "2026-10-06", due: false });
    expect(digestWindow(new Date("2026-10-06T12:00:00Z"))).toMatchObject({ dateKey: "2026-10-06", due: true });
    expect(digestWindow(new Date("2026-10-06T23:30:00Z")).due).toBe(true);
  });

  it("follows the Central calendar date, not UTC", () => {
    // 2:00 AM UTC on Oct 7 is still the evening of Oct 6 in Central time.
    expect(centralDateKey(new Date("2026-10-07T02:00:00Z"))).toBe("2026-10-06");
    expect(digestWindow(new Date("2026-10-07T02:00:00Z"))).toMatchObject({ dateKey: "2026-10-06", due: true });
  });

  it("uses standard time in winter: 7:00 AM CST is 13:00 UTC", () => {
    expect(centralInstant("2027-01-15", 7).toISOString()).toBe("2027-01-15T13:00:00.000Z");
    expect(centralInstant("2026-10-06", 7).toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(digestWindow(new Date("2027-01-15T12:59:00Z")).due).toBe(false);
    expect(digestWindow(new Date("2027-01-15T13:00:00Z")).due).toBe(true);
  });

  it("holds the send time across the daylight saving changes", () => {
    // Clocks move at 2:00 AM, so 7:00 AM is always 7:00 AM local.
    expect(centralInstant("2026-03-08", 7).toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(centralInstant("2026-11-01", 7).toISOString()).toBe("2026-11-01T13:00:00.000Z");
  });

  it("keys one message per recipient per Central date, ignoring case", () => {
    expect(digestIdempotencyKey("2026-10-06", "Pat@Example.test")).toBe("location-waitlist-digest:2026-10-06:pat@example.test");
    expect(digestIdempotencyKey("2026-10-06", "pat@example.test")).toBe(digestIdempotencyKey("2026-10-06", " PAT@example.TEST "));
    expect(digestIdempotencyKey("2026-10-07", "pat@example.test")).not.toBe(digestIdempotencyKey("2026-10-06", "pat@example.test"));
  });
});

describe("the digest email", () => {
  const sections: DigestEventSection[] = [
    {
      eventName: "Honors Weekend 2027",
      locations: [
        {
          locationName: "Camp Heritage 1",
          changes: [
            { kind: "JOINED", clubName: "River City Pathfinders", attendeeCount: 12, place: 2, occurredAt: new Date("2026-10-05T20:15:00Z") },
            { kind: "PROMOTED", clubName: "Prairie Adventurers", attendeeCount: 1, place: 1, occurredAt: new Date("2026-10-05T21:00:00Z") },
            { kind: "REMOVED", clubName: "Oak Hill Explorers", attendeeCount: 5, place: 3, occurredAt: new Date("2026-10-05T22:30:00Z") },
          ],
        },
        { locationName: "Des Moines", changes: [{ kind: "JOINED", clubName: "Lakeside Guides", attendeeCount: 8, place: 1, occurredAt: new Date("2026-10-05T23:00:00Z") }] },
      ],
    },
    { eventName: "Fall Camporee", locations: [{ locationName: "Iowa", changes: [{ kind: "JOINED", clubName: "Hilltop Trailblazers", attendeeCount: 20, place: null, occurredAt: new Date("2026-10-05T23:30:00Z") }] }] },
  ];

  it("lists what joined (with place in line), was promoted, and was removed, grouped by event and location", () => {
    const { subject, bodyText } = buildLocationWaitlistDigest({ recipientName: "Pat Coordinator", dateKey: "2026-10-06", sections, reason: "COORDINATOR" });
    expect(subject).toBe("Location waitlist changes: 5 updates (October 6, 2026)");
    expect(bodyText).toContain("Hello Pat Coordinator,");
    expect(bodyText).toContain("Honors Weekend 2027\nCamp Heritage 1\n");
    expect(bodyText).toContain("Joined the waitlist: River City Pathfinders (12 people, place #2 in line) at 3:15 PM Central");
    expect(bodyText).toContain("Promoted to a registration: Prairie Adventurers (1 person, was place #1 in line)");
    expect(bodyText).toContain("Removed from the waitlist: Oak Hill Explorers (5 people, was place #3 in line)");
    expect(bodyText).toContain("Des Moines\n  - Joined the waitlist: Lakeside Guides (8 people, place #1 in line)");
    expect(bodyText).toContain("Fall Camporee\nIowa\n  - Joined the waitlist: Hilltop Trailblazers (20 people) at");
    expect(bodyText.indexOf("Honors Weekend 2027")).toBeLessThan(bodyText.indexOf("Fall Camporee"));
  });

  it("says why the person is receiving it, and that it is sent once a day", () => {
    const coordinator = buildLocationWaitlistDigest({ recipientName: "Pat", dateKey: "2026-10-06", sections, reason: "COORDINATOR" }).bodyText;
    const staff = buildLocationWaitlistDigest({ recipientName: "Pat", dateKey: "2026-10-06", sections, reason: "STAFF" }).bodyText;
    const both = buildLocationWaitlistDigest({ recipientName: "Pat", dateKey: "2026-10-06", sections, reason: "BOTH" }).bodyText;
    expect(coordinator).toContain("as the Area Coordinator for these locations");
    expect(staff).toContain("as an event administrator for these events");
    expect(both).toContain("as an Area Coordinator and an event administrator");
    expect(coordinator).toContain("sent once a day, and only on days with changes");
  });

  it("counts updates and uses the singular for one", () => {
    expect(digestCount(sections)).toBe(5);
    const single = buildLocationWaitlistDigest({ recipientName: "", dateKey: "2026-10-06", sections: [sections[1]!], reason: "STAFF" });
    expect(single.subject).toBe("Location waitlist changes: 1 update (October 6, 2026)");
    expect(single.bodyText).toContain("Hello there,");
  });

  it("carries no link or token: it is plain text for a named person", () => {
    const { bodyText } = buildLocationWaitlistDigest({ recipientName: "Pat", dateKey: "2026-10-06", sections, reason: "STAFF" });
    expect(bodyText).not.toMatch(/https?:\/\//);
    expect(bodyText).not.toContain("{{");
  });
});
