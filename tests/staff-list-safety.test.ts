import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cappedNotice, clampPage, newestFirst, paginate } from "@/lib/pagination";
import { ListPager } from "@/components/list-pager";
import {
  SQUARE_CANDIDATES_DEFAULT,
  SQUARE_CANDIDATES_SEARCH,
  squareCandidateWindow,
} from "@/components/square-payment-matching";
import {
  BackgroundCheckReviewPanel,
  MatchAnywayDialog,
  UNMATCHED_NARROWING_GUIDANCE,
  UNMATCHED_PAGE_SIZE,
} from "@/components/background-check-review-panel";
import {
  ARRIVALS_PAGE_SIZE,
  AWAITING_ARRIVAL_LABEL,
  CheckInWorkspace,
} from "@/components/check-in-workspace";
import { DELIVERY_PAGE_SIZE, DELIVERY_SERVER_CAP } from "@/components/communications-workspace";
import { projectCheckInArrivals } from "@/modules/checkin/arrival-view";
import type { RegistrationRecord } from "@/modules/registrations/repository";

/**
 * Staff list safety (#702). React renders without a DOM here (see
 * vitest.config.ts), so paging is proven on the pure helpers the components
 * call, and the markup assertions cover what staff see on first render.
 */

const numbers = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const noop = () => {};

describe("paginate", () => {
  it("slices a page and reports the range and total", () => {
    const slice = paginate(numbers(120), 2, 50);
    expect(slice.items).toHaveLength(50);
    expect(slice.items[0]).toBe(51);
    expect(slice).toMatchObject({ page: 2, pageCount: 3, total: 120, from: 51, to: 100 });
  });

  it("shows the short last page", () => {
    const slice = paginate(numbers(120), 3, 50);
    expect(slice.items).toHaveLength(20);
    expect(slice).toMatchObject({ from: 101, to: 120 });
  });

  it("clamps an out-of-range page and handles an empty list", () => {
    expect(paginate(numbers(10), 99, 50).page).toBe(1);
    expect(paginate(numbers(120), -4, 50).page).toBe(1);
    expect(clampPage(Number.NaN, 120, 50)).toBe(1);
    expect(paginate([], 1, 50)).toMatchObject({ items: [], pageCount: 1, total: 0, from: 0, to: 0 });
  });

  it("orders newest first without mutating the input", () => {
    const rows = [{ at: "2026-09-01T00:00:00Z" }, { at: "2026-09-03T00:00:00Z" }, { at: "2026-09-02T00:00:00Z" }];
    expect(newestFirst(rows, (row) => row.at).map((row) => row.at)).toEqual([
      "2026-09-03T00:00:00Z",
      "2026-09-02T00:00:00Z",
      "2026-09-01T00:00:00Z",
    ]);
    expect(rows[0]!.at).toBe("2026-09-01T00:00:00Z");
  });

  it("renders the pager with a range, and only the count when one page holds everything", () => {
    const many = renderToStaticMarkup(createElement(ListPager, { label: "Test pages", onPage: noop, slice: paginate(numbers(120), 1, 50) }));
    expect(many).toContain("of 120");
    expect(many).toContain("Page 1 of 3");
    expect(many).toContain("Next");
    const one = renderToStaticMarkup(createElement(ListPager, { label: "Test pages", onPage: noop, slice: paginate(numbers(5), 1, 50) }));
    expect(one).toContain("of 5");
    expect(one).not.toContain("Next");
    expect(renderToStaticMarkup(createElement(ListPager, { label: "Test pages", onPage: noop, slice: paginate([], 1, 50) }))).toBe("");
  });
});

describe("the Square payment-match candidate cap (F-S1)", () => {
  it("caps at 8 with no query and 25 with one, and says how many matched", () => {
    const rows = numbers(40);
    const idle = squareCandidateWindow(rows, "");
    expect(SQUARE_CANDIDATES_DEFAULT).toBe(8);
    expect(idle.shown).toHaveLength(8);
    expect(idle.total).toBe(40);
    expect(idle.notice).toBe("Showing 8 of 40 — refine the search");

    const searching = squareCandidateWindow(rows, "smith");
    expect(SQUARE_CANDIDATES_SEARCH).toBe(25);
    expect(searching.shown).toHaveLength(25);
    expect(searching.notice).toBe("Showing 25 of 40 — refine the search");
  });

  it("shows no notice when every match fits", () => {
    expect(squareCandidateWindow(numbers(8), "").notice).toBe("");
    expect(squareCandidateWindow(numbers(3), "smith").notice).toBe("");
    expect(cappedNotice(3, 3)).toBe("");
  });
});

describe("searching a paged list (#702)", () => {
  it("finds a match beyond the first page, and a new search starts on page 1", () => {
    const names = numbers(120).map((n) => `Person ${n}`);
    // A search runs over the whole list before paging, so row 117 is found.
    const matches = names.filter((name) => name.includes("117"));
    expect(paginate(matches, 1, 50).items).toEqual(["Person 117"]);
    // Browsing to page 3, then searching: the page is reset to 1 and stays valid.
    expect(paginate(names, 3, 50).page).toBe(3);
    expect(paginate(matches, 1, 50).page).toBe(1);
    // A stale page past the end of a narrowed list is clamped back into range.
    expect(paginate(matches, 3, 50).page).toBe(1);
  });
});

describe("page sizes", () => {
  it("pages the delivery log, the arrival roster and the unmatched rows at 50", () => {
    expect(DELIVERY_PAGE_SIZE).toBe(50);
    expect(DELIVERY_SERVER_CAP).toBe(150);
    expect(ARRIVALS_PAGE_SIZE).toBe(50);
    expect(UNMATCHED_PAGE_SIZE).toBe(50);
  });
});

function registration(index: number): RegistrationRecord {
  return {
    id: `registration-${index}`,
    confirmationCode: `TEST-${String(index).padStart(4, "0")}`,
    status: "CONFIRMED",
    accountHolder: { firstName: "Pat", lastName: `Example${index}`, email: `pat${index}@example.test` },
    attendees: [{
      id: `attendee-${index}`,
      firstName: "Casey",
      lastName: `Sample${index}`,
      attendeeType: "YOUTH",
      checkedIn: false,
      checkedInAt: null,
    }],
    payments: [],
    totalAmountCents: 0,
    balanceCents: 0,
  } as unknown as RegistrationRecord;
}

describe("the check-in roster (F-S4, F-S5)", () => {
  const render = () => renderToStaticMarkup(createElement(CheckInWorkspace, {
    eventName: "Synthetic Event",
    eventId: "event-1",
    initialArrivals: projectCheckInArrivals(numbers(120).map(registration), { showBalances: false }),
    canCheckIn: true,
  }));

  it("labels the tally and the rows the same way", () => {
    expect(AWAITING_ARRIVAL_LABEL).toBe("Awaiting arrival");
    const html = render();
    expect(html).not.toContain("Not confirmed");
    expect(html).toContain(`<small>${AWAITING_ARRIVAL_LABEL}</small>`);
    expect(html).toContain(`<span class="arrival-time">${AWAITING_ARRIVAL_LABEL}</span>`);
  });

  it("renders one page of the roster, not all 120 arrivals", () => {
    const html = render();
    expect(html.match(/class="arrival-row"/g)).toHaveLength(ARRIVALS_PAGE_SIZE);
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain("120 match");
  });
});

describe("the background-check review panel (F-S6, F-S8, F-S9)", () => {
  it("shows a loading state instead of nothing while the lists load", () => {
    const html = renderToStaticMarkup(createElement(BackgroundCheckReviewPanel));
    expect(html).toContain("Loading the review list");
    expect(html).toContain('aria-busy="true"');
  });

  it("asks before matching someone staff earlier rejected", () => {
    const html = renderToStaticMarkup(createElement(MatchAnywayDialog, {
      onCancel: noop,
      onConfirm: noop,
      target: { rowName: "Sample Row", personName: "Sample Person" },
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Match them anyway?");
    expect(html).toContain("Sample Row");
    expect(html).toContain("Sample Person");
    expect(html).toContain("Cancel");
  });

  it("renders no dialog until a match is chosen", () => {
    expect(renderToStaticMarkup(createElement(MatchAnywayDialog, { onCancel: noop, onConfirm: noop, target: null }))).toBe("");
  });

  it("points at the name lookup to narrow the conference-wide rows", () => {
    expect(UNMATCHED_NARROWING_GUIDANCE).toContain("name lookup");
  });
});
