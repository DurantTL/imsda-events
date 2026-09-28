import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubOrderWorkspace, orderExportHref, type ClubOrderWorkspaceData } from "@/components/club-order-workspace";
import { applyExtras } from "@/modules/club-orders/domain";
import { parseExtrasQuery } from "@/modules/club-orders/schemas";

/**
 * The club honor order screen (#487), initial-render markup (React renders
 * without a DOM here): what a director or deputy sees versus a registrar or
 * Area Coordinator, the flags, and that no personal field beyond names is
 * shown. Synthetic data only.
 */

const data: ClubOrderWorkspaceData = {
  lines: [
    { item: { itemId: "i1", name: "Camping Skills", catalogNumber: "005157" }, needed: 3, extra: 0, inStock: 1, toOrder: 2, missingCatalogNumber: false },
    { item: { itemId: "i2", name: "Wilderness Living", catalogNumber: null }, needed: 1, extra: 0, inStock: 0, toOrder: 1, missingCatalogNumber: true },
  ],
  unmatched: [{ sourceId: "s1", personId: "p1" }],
  batches: [
    { id: "b1", status: "ORDERED", createdAt: "2026-09-20T15:00:00.000Z", receivedAt: null, itemCount: 1, totalQuantity: 4, lines: [] },
    { id: "b2", status: "RECEIVED", createdAt: "2026-08-20T15:00:00.000Z", receivedAt: "2026-08-25T15:00:00.000Z", itemCount: 1, totalQuantity: 2, lines: [] },
  ],
  awardable: [
    { needId: "n1", itemId: "i1", itemName: "Camping Skills", firstName: "Alex", lastName: "Sample", fromStock: false },
    { needId: "n2", itemId: "i1", itemName: "Camping Skills", firstName: "Jordan", lastName: "Example", fromStock: true },
  ],
  waiting: [
    { needId: "n2", itemName: "Camping Skills", sourceLabel: "Camping Skills", sourceDate: "2025-05-01", firstName: "Jordan", lastName: "Example", beforeFirstOrder: true },
    { needId: "n3", itemName: null, sourceLabel: "Orienteering", sourceDate: "2026-09-20", firstName: "Riley", lastName: "Test", beforeFirstOrder: false },
  ],
  firstOrderAt: "2026-08-20T15:00:00.000Z",
};

const render = (readOnly: boolean) => renderToStaticMarkup(
  createElement(ClubOrderWorkspace, { organizationId: "club-1", initial: data, readOnly }),
);

describe("ClubOrderWorkspace (#487)", () => {
  it("gives a director or deputy the edit controls", () => {
    const html = render(false);
    expect(html).toContain("Place order");
    expect(html).toContain("Mark received");
    expect(html).toContain("Mark awarded");
    expect(html).toContain("Select all");
    expect(html).toContain('type="number"');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("View only");
  });

  it("shows a registrar or Area Coordinator the same lists with no controls", () => {
    const html = render(true);
    expect(html).toContain("View only");
    expect(html).toContain("Camping Skills");
    expect(html).toContain("Alex Sample");
    expect(html).not.toContain("Place order");
    expect(html).not.toContain("Mark received");
    expect(html).not.toContain("Mark awarded");
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('type="checkbox"');
  });

  it("flags an item with no AdventSource number and an honor with no catalog item", () => {
    for (const readOnly of [false, true]) {
      const html = render(readOnly);
      expect(html).toContain("No AdventSource number");
      expect(html).toContain("left out of the AdventSource file");
      expect(html).toContain("no matching catalog item");
    }
  });

  it("offers the three downloads", () => {
    const html = render(true);
    expect(html).toContain("/api/attendee/clubs/club-1/orders/csv?view=adventsource");
    expect(html).toContain("/api/attendee/clubs/club-1/orders/csv?view=readable");
    expect(html).toContain("/api/attendee/clubs/club-1/orders/csv?view=picklist");
  });

  it("offers each placed order's AdventSource file, readable order list, and pick list", () => {
    const html = render(true);
    for (const view of ["adventsource", "readable", "picklist"]) {
      expect(html).toContain(`/api/attendee/clubs/club-1/orders/csv?view=${view}&amp;batch=b1`);
    }
  });

  it("carries the screen's extras on the top-level AdventSource and readable links", () => {
    const lines = applyExtras(data.lines, { i1: "2" });
    const base = "/api/attendee/clubs/club-1/orders";
    expect(orderExportHref(base, "adventsource", lines)).toBe(`${base}/csv?view=adventsource&extra=i1%3A2`);
    expect(orderExportHref(base, "readable", lines)).toBe(`${base}/csv?view=readable&extra=i1%3A2`);
    expect(orderExportHref(base, "picklist", lines)).toBe(`${base}/csv?view=picklist`);
    // And the round trip: the server's parser reads back exactly the screen's extras.
    const query = new URL(orderExportHref(base, "readable", lines), "https://events.imsda.test").searchParams;
    expect(parseExtrasQuery(query)).toEqual({ i1: 2 });
  });

  it("marks a need stock already covers as ready to hand out from stock", () => {
    const html = render(false);
    expect(html).toContain("Jordan Example");
    expect(html).toContain("from stock");
  });

  it("offers editors the one-time 'already handed out' prompt for honors completed before ordering started", () => {
    const html = render(false);
    expect(html).toContain("Honors completed before you started ordering here");
    expect(html).toContain("Mark the ones already handed out.");
    expect(html).toContain("Already handed out");
    expect(html).toContain("Select all (1)");
    expect(html).toContain("Completed before");
    // Only the need recorded before the first order is offered, and nothing is pre-checked.
    expect(html).not.toContain("Riley Test");
    expect(html).not.toMatch(/checked=""/);
    expect(render(true)).not.toContain("Already handed out");
  });

  it("shows names and items only, no other personal field", () => {
    const html = render(false);
    expect(html).not.toMatch(/birth|phone|email|guardian|allerg|medical|address/i);
  });
});
