import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutoEventInfoCards } from "@/components/auto-event-info-cards";
import { ClubYearTiles } from "@/components/club-year-tiles";
import type { EventInfoCards } from "@/modules/event-info-cards/domain";

/** Heading order fixes from the mobile pass (#687): no skipped levels, no repeated "Fees". */
const tileProps = {
  roster: { active: 3, staff: 1, members: 2, byClass: [] },
  rosterHref: "/account/clubs/club-1/roster",
  honors: null,
  honorsHref: "/account/clubs/club-1/honors",
  compliance: null,
  complianceHref: "/account/clubs/club-1/roster",
  events: { open: 0, registered: 0 },
  eventsHref: "/account/clubs/club-1/events",
  reports: null,
  reportsHref: "/account/clubs/club-1/records",
} as Parameters<typeof ClubYearTiles>[0];

describe("club dashboard tile headings", () => {
  it("are h2s, so the club page goes h1 to h2 with no h3 before an h2", () => {
    const html = renderToStaticMarkup(createElement(ClubYearTiles, tileProps));
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h3");
  });

  it("are h3s when the page puts its own h2 above them (staff club pages)", () => {
    const html = renderToStaticMarkup(createElement(ClubYearTiles, { ...tileProps, headingLevel: 3 }));
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h2");
  });
});

describe("event page Fees card", () => {
  const cards = (groupTitle: string, isSingles = false): EventInfoCards => ({
    header: { eyebrow: "", title: "Synthetic event", tagline: null, meta: "", subtitle: null },
    classes: null,
    dates: null,
    deadlines: null,
    fees: {
      notes: [],
      sections: [{
        title: null,
        groups: [{ title: groupTitle, isSingles, lines: [{ label: "Registration", unit: null, tiers: [{ amountCents: 5000, note: null }] }] }],
      }],
    },
    steps: null,
    help: null,
  });

  it("does not repeat the card heading as a group heading", () => {
    const html = renderToStaticMarkup(createElement(AutoEventInfoCards, { cards: cards("Fees", true) }));
    expect(html.match(/>Fees</g)).toHaveLength(1);
    expect(html).not.toContain("<h3");
  });

  it("keeps a group that is merely titled Fees but is not the plain-price group", () => {
    const html = renderToStaticMarkup(createElement(AutoEventInfoCards, { cards: cards("Fees") }));
    expect(html).toContain("<h3>Fees</h3>");
  });

  it("keeps a differently named group heading", () => {
    const html = renderToStaticMarkup(createElement(AutoEventInfoCards, { cards: cards("Lodging") }));
    expect(html).toContain("<h3>Lodging</h3>");
  });
});
