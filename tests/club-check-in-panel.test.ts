import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClubCheckInPanel,
  pendingAttendeeIds,
  selectedPendingAttendeeIds,
  type ClubCheckInAttendeeView,
} from "@/components/club-check-in-panel";

/**
 * Q1 (#412): checking in a whole club at once. This environment renders
 * React without a DOM (see vitest.config.ts), so interaction is proven at
 * the pure-function level — exactly what the "Check in all"/"Check in
 * selected" buttons call — and the markup assertions cover what staff see.
 */

function attendee(
  overrides: Partial<ClubCheckInAttendeeView> & { id: string },
): ClubCheckInAttendeeView {
  return {
    firstName: "Pat",
    lastName: "Pathfinder",
    attendeeType: "YOUTH",
    checkedIn: false,
    backgroundFlagged: false,
    ...overrides,
  };
}

describe("who a bulk club check-in reaches (#412)", () => {
  it("checks in everyone not already checked in for 'Check in all'", () => {
    const roster = [
      attendee({ id: "a1", checkedIn: false }),
      attendee({ id: "a2", checkedIn: true }),
      attendee({ id: "a3", checkedIn: false }),
    ];
    expect(pendingAttendeeIds(roster)).toEqual(["a1", "a3"]);
  });

  it("checks in only the selected people for a partial (some-came) check-in", () => {
    const roster = [
      attendee({ id: "a1", checkedIn: false }),
      attendee({ id: "a2", checkedIn: false }),
      attendee({ id: "a3", checkedIn: false }),
    ];
    expect(selectedPendingAttendeeIds(roster, new Set(["a1", "a3"]))).toEqual(["a1", "a3"]);
  });

  it("drops an already-checked-in person from the selection instead of re-sending them (repeats)", () => {
    const roster = [
      attendee({ id: "a1", checkedIn: true }),
      attendee({ id: "a2", checkedIn: false }),
    ];
    // Both were ticked, but a1 became checked in (e.g. by another device)
    // while the club view was open.
    expect(selectedPendingAttendeeIds(roster, new Set(["a1", "a2"]))).toEqual(["a2"]);
  });

  it("keeps selection order matching roster order, and drops a selected id no longer on the roster", () => {
    const roster = [
      attendee({ id: "a1", checkedIn: false }),
      attendee({ id: "a2", checkedIn: false }),
    ];
    expect(selectedPendingAttendeeIds(roster, new Set(["gone", "a2", "a1"]))).toEqual(["a1", "a2"]);
  });
});

describe("club check-in panel markup (#412)", () => {
  it("shows the club name, confirmation code, amount billed to the church, and flags — never a payment action", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: 6300,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [
        attendee({ id: "a1", firstName: "Riley", lastName: "Roamer", checkedIn: false, backgroundFlagged: true }),
        attendee({ id: "a2", firstName: "Sam", lastName: "Scout", checkedIn: true }),
      ],
    }));

    expect(markup).toContain("Ankeny Son-Seekers");
    expect(markup).toContain("REG-A1");
    expect(markup).toContain("$63.00 billed to church");
    expect(markup).toContain("Background check needed");
    expect(markup).toContain("Check in all (1)");
    expect(markup).not.toContain("Pay");
    expect(markup).not.toContain("Refund");
  });

  it("leaves out the church amount when the event doesn't bill one (amountOwedCents null)", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1" })],
    }));

    expect(markup).not.toContain("billed to church");
  });

  it("disables both bulk buttons once every attendee is already checked in", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: 0,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1", checkedIn: true }), attendee({ id: "a2", checkedIn: true })],
    }));

    expect(markup).toContain("Check in all (0)");
    expect(markup).toContain("Check in selected (0)");
    // Both bulk buttons and both now-checked-in checkboxes are disabled.
    expect(markup.match(/disabled=""/g)?.length).toBe(4);
  });

  it("leaves a clearly empty campsite slot instead of inventing assignment data (#410)", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1" })],
    }));

    expect(markup).toContain("Campsite and assignments aren’t available yet.");
  });
});
