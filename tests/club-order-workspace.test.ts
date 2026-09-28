import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubOrderWorkspace, type ClubOrderWorkspaceData } from "@/components/club-order-workspace";

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
  awardable: [{ needId: "n1", itemId: "i1", itemName: "Camping Skills", firstName: "Alex", lastName: "Sample" }],
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

  it("shows names and items only, no other personal field", () => {
    const html = render(false);
    expect(html).not.toMatch(/birth|phone|email|guardian|allerg|medical|address/i);
  });
});
