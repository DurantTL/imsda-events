import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubEventList } from "@/components/club-event-list";
import type { ClubEventSummary } from "@/modules/club-registrations/repository";

/**
 * Events & classes tab (#478): an open club event needs a real "Register
 * your club" action, and an empty roster of events needs a real
 * explanation instead of a blank tab.
 */

function event(overrides: Partial<ClubEventSummary> & { id: string }): ClubEventSummary {
  return {
    name: "Fall Camporee",
    startsAt: "2026-11-06T15:00:00.000Z",
    endsAt: "2026-11-08T20:00:00.000Z",
    timezone: "America/New_York",
    location: "Camp Fictitious",
    phase: "OPEN",
    registrationClosesOn: null,
    available: true,
    problem: null,
    registration: null,
    draft: null,
    registeredLocation: null,
    hasLocations: false,
    ...overrides,
  };
}

describe("ClubEventList (#478)", () => {
  it("explains that no club events are open, instead of an empty tab", () => {
    const markup = renderToStaticMarkup(createElement(ClubEventList, { events: [], organizationId: "org-1" }));
    expect(markup).toContain("appear here once the conference publishes registration");
  });

  it("shows an open club event with a working 'Register your club' link", () => {
    const markup = renderToStaticMarkup(
      createElement(ClubEventList, { events: [event({ id: "evt-1" })], organizationId: "org-1" }),
    );
    expect(markup).toContain("Fall Camporee");
    expect(markup).toContain('href="/account/clubs/org-1/events/evt-1"');
    expect(markup).toContain("Register");
  });

  it("offers 'View' instead, once the club is registered", () => {
    const markup = renderToStaticMarkup(
      createElement(ClubEventList, {
        events: [event({ id: "evt-1", registration: { confirmationCode: "ABC123", status: "CONFIRMED", attendeeCount: 8 } })],
        organizationId: "org-1",
      }),
    );
    expect(markup).toContain('href="/account/clubs/org-1/events/evt-1"');
    expect(markup).toContain("View");
    expect(markup).not.toContain(">Register<");
  });

  it("shows no register action for an event not yet available to clubs", () => {
    const markup = renderToStaticMarkup(
      createElement(ClubEventList, {
        events: [event({ id: "evt-1", available: false, problem: "The event has no published registration form yet." })],
        organizationId: "org-1",
      }),
    );
    expect(markup).toContain("Not open for clubs yet");
    expect(markup).not.toContain("/events/evt-1");
  });
});
