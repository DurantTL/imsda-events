import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClubCheckInPanel,
  clubAttendeeStatusLabel,
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

  it("leaves a saved check-in that needs review out of 'Check in all' (#412)", () => {
    const roster = [
      attendee({ id: "a1" }),
      attendee({ id: "a2", savedState: "CONFLICT" }),
      attendee({ id: "a3", savedState: "QUEUED" }),
    ];
    expect(pendingAttendeeIds(roster)).toEqual(["a1", "a3"]);
  });

  it("also leaves out someone whose last attempt failed even though nothing was saved to the queue (reviewer leftover)", () => {
    const roster = [
      attendee({ id: "a1" }),
      attendee({ id: "a2", lastResult: "CONFLICT" }),
      attendee({ id: "a3", lastResult: "QUEUED" }),
    ];
    // a2 matches the same "Needs review" rule clubAttendeeStatusLabel uses,
    // so it must be excluded from "Check in all" exactly like a2 with a
    // saved CONFLICT is above — savedState and lastResult are not allowed
    // to disagree about who gets left out.
    expect(pendingAttendeeIds(roster)).toEqual(["a1", "a3"]);
  });

  it("retries a needs-review attendee only when staff explicitly tick them for 'Check in selected'", () => {
    const roster = [
      attendee({ id: "a1" }),
      attendee({ id: "a2", savedState: "CONFLICT" }),
    ];
    expect(selectedPendingAttendeeIds(roster, new Set(["a2"]))).toEqual(["a2"]);
    expect(selectedPendingAttendeeIds(roster, new Set())).toEqual([]);
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

  it("uses an h2 on the check-in page and an h3 inside the scanner dialog", () => {
    const base = {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1" })],
    };
    expect(renderToStaticMarkup(createElement(ClubCheckInPanel, base))).toContain("<h2");
    const inDialog = renderToStaticMarkup(createElement(ClubCheckInPanel, { ...base, headingLevel: 3 }));
    expect(inDialog).toContain("<h3");
    expect(inDialog).not.toContain("<h2");
  });

  it("disables every check-in control while unreadable saved-queue data is present", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      savedQueueUnreadable: true,
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1" }), attendee({ id: "a2" })],
    }));
    expect(markup).toContain("Unreadable saved check-in data");
    // Two bulk buttons + two checkboxes, all disabled.
    expect(markup.match(/disabled=""/g)?.length).toBe(4);
  });

  it("announces progress in a live region and on the button while a club run is going", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: true,
      progress: { current: 12, total: 40 },
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1" })],
    }));
    expect(markup).toMatch(/aria-live="polite"[^>]*>Checking in 12 of 40…<\/p>/);
    expect(markup).toMatch(/<button[^>]*>.*?Checking in 12 of 40…<\/button>/);
  });

  it("marks attendees whose last attempt failed as needing review", () => {
    expect(clubAttendeeStatusLabel(attendee({ id: "a1", lastResult: "CONFLICT" }))).toBe("Needs review");
    expect(clubAttendeeStatusLabel(attendee({ id: "a1", savedState: "CONFLICT" }))).toBe("Needs review");
    expect(clubAttendeeStatusLabel(attendee({ id: "a1", lastResult: "QUEUED" }))).toBe("Queued — not confirmed");
    expect(clubAttendeeStatusLabel(attendee({ id: "a1", checkedIn: true, lastResult: "CONFLICT" }))).toBe("Checked in");

    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [attendee({ id: "a1", firstName: "Riley", lastName: "Roamer", savedState: "CONFLICT" })],
    }));
    expect(markup).toContain("Needs review");
    expect(markup).toContain("left out of “Check in all”");
    expect(markup).toContain("Check in all (0)");
  });

  it("matches the review note to the count 'Check in all' actually excludes, even for a lastResult-only conflict", () => {
    const markup = renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      onCheckInMany: () => {},
      attendees: [
        attendee({ id: "a1" }),
        attendee({ id: "a2", firstName: "Riley", lastName: "Roamer", lastResult: "CONFLICT" }),
      ],
    }));
    expect(markup).toContain("Check in all (1)");
    expect(markup).toContain("1 person needs");
    expect(markup).toContain("left out of “Check in all”");
  });
});

describe("club view opened by one member's scanned QR pass (#412)", () => {
  const roster = [
    attendee({ id: "a1", firstName: "Riley", lastName: "Roamer" }),
    attendee({ id: "a2", firstName: "Sam", lastName: "Scout" }),
    attendee({ id: "a3", firstName: "Lee", lastName: "Late" }),
  ];

  function render(overrides: Partial<Parameters<typeof ClubCheckInPanel>[0]> = {}) {
    return renderToStaticMarkup(createElement(ClubCheckInPanel, {
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      amountOwedCents: null,
      canCheckIn: true,
      busy: false,
      headingLevel: 3,
      onCheckInMany: () => {},
      onCheckInScanned: () => {},
      scannedAttendeeId: "a3",
      attendees: roster,
      ...overrides,
    }));
  }

  it("makes checking in the scanned person the one primary action, with the whole club behind a disclosure", () => {
    const markup = render();
    expect(markup).toContain("Scanned pass");
    const primaryButtons = markup.match(/<button class="primary-button"[^>]*>.*?<\/button>/g) ?? [];
    expect(primaryButtons).toHaveLength(1);
    expect(primaryButtons[0]).toContain("Check in <span translate=\"no\">Lee Late</span>");

    const scannedIndex = markup.indexOf("Scanned pass");
    const detailsIndex = markup.indexOf("<details");
    const checkInAllIndex = markup.indexOf("Check in all (3)");
    expect(scannedIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(scannedIndex);
    expect(checkInAllIndex).toBeGreaterThan(detailsIndex);
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Open whole club (3)");
    expect(markup).toMatch(/<button class="secondary-button"[^>]*>.*?Check in all \(3\)/);
  });

  it("offers a retry for a scanned person needing review, and no button once they're checked in", () => {
    expect(render({
      attendees: roster.map((entry) => entry.id === "a3" ? { ...entry, savedState: "CONFLICT" as const } : entry),
    })).toContain("Retry check-in for <span translate=\"no\">Lee Late</span>");

    const checkedIn = render({
      attendees: roster.map((entry) => entry.id === "a3" ? { ...entry, checkedIn: true } : entry),
    });
    expect(checkedIn).not.toContain("Check in <span translate=\"no\">Lee Late</span>");
    expect(checkedIn.match(/class="primary-button"/g)).toBeNull();
  });

  it("keeps the plain club view (Check in all as primary) for a confirmation-code lookup", () => {
    const markup = render({ scannedAttendeeId: undefined });
    expect(markup).not.toContain("Scanned pass");
    expect(markup).not.toContain("<details");
    expect(markup).toMatch(/<button class="primary-button"[^>]*>.*?Check in all \(3\)/);
  });
});
