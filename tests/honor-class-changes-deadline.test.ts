import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { classChangesClosedMessage, classChangesEnded, classChangesOpen } from "@/modules/honors/locations";

const event = {
  isPublished: true,
  timezone: "America/Chicago",
  registrationOpensOn: "2026-10-01",
  registrationClosesOn: "2026-11-30",
  waitlistEnabled: false,
  endsAt: new Date("2026-12-06T20:00:00Z"),
};
const site = (registrationClosesOn: string | null) => ({ firstDay: null, lastDay: null, registrationClosesOn });

describe("the one class-change deadline (#831)", () => {
  it("uses the event's close when the site has none", () => {
    expect(classChangesOpen(event, site(null), new Date("2026-11-30T20:00:00Z"))).toBe(true);
    expect(classChangesOpen(event, null, new Date("2026-12-01T20:00:00Z"))).toBe(false);
  });

  it("uses the site's own close when it has one, earlier or later than the event's", () => {
    expect(classChangesOpen(event, site("2026-10-20"), new Date("2026-10-19T20:00:00Z"))).toBe(true);
    expect(classChangesOpen(event, site("2026-10-20"), new Date("2026-10-21T20:00:00Z"))).toBe(false);
    // The close date passing is a deadline, not an end: staff can extend it, so the line is kept.
    expect(classChangesEnded(event, site("2026-10-20"), new Date("2026-10-21T20:00:00Z"))).toBe(false);
    expect(classChangesEnded(event, { firstDay: null, lastDay: "2026-10-25", registrationClosesOn: null }, new Date("2026-10-26T20:00:00Z"))).toBe(true);
    expect(classChangesEnded(event, null, new Date("2026-12-07T20:00:00Z"))).toBe(true);
  });

  it("is not 'over for good' before registration opens", () => {
    const early = new Date("2026-09-20T20:00:00Z");
    expect(classChangesOpen(event, null, early)).toBe(false);
    expect(classChangesEnded(event, null, early)).toBe(false);
  });

  it("says why, naming the site's close date", () => {
    expect(classChangesClosedMessage(event, site("2026-10-20"), new Date("2026-10-21T20:00:00Z"))).toBe("Class choices closed after 2026-10-20.");
    expect(classChangesClosedMessage(event, null, new Date("2027-01-01T00:00:00Z"))).toBe("Registration for this event has closed.");
  });
});
