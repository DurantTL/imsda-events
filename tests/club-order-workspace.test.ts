import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ADVENTSOURCE_URL, ClubOrderWorkspace, ORDER_SECTION_IDS, orderSectionLinks, type ClubOrderWorkspaceData } from "@/components/club-order-workspace";
import type { ClubStockRow } from "@/modules/club-supplies/repository";

/**
 * The club Orders screen (#487, #654), initial-render markup (React renders
 * without a DOM here): the helper notice, the sectioned list, what a director
 * or deputy sees versus a registrar or Area Coordinator, the flags, and that
 * no personal field beyond names is shown. Synthetic data only.
 */

const data: ClubOrderWorkspaceData = {
  helper: [
    { itemId: "u1", section: "UNIFORMS", name: "Boys' Shirt", size: "M", catalogNumber: "011112", computedNeeded: 2, needed: 2, edited: false, onHand: 0, toOrder: 2 },
    { itemId: "u2", section: "UNIFORMS", name: "Boys' Shirt", size: "L", catalogNumber: "011113", computedNeeded: 2, needed: 1, edited: true, onHand: 0, toOrder: 1 },
    { itemId: "i1", section: "HONORS", name: "Camping Skills", size: "", catalogNumber: "005157", computedNeeded: 3, needed: 3, edited: false, onHand: 1, toOrder: 2 },
    { itemId: "i2", section: "HONORS", name: "Wilderness Living", size: "", catalogNumber: null, computedNeeded: 1, needed: 1, edited: false, onHand: 0, toOrder: 1 },
    { itemId: "o1", section: "OTHER", name: "Good Conduct Star", size: "", catalogNumber: "000123", computedNeeded: 0, needed: 4, edited: true, onHand: 0, toOrder: 4 },
    { itemId: "i3", section: "HONORS", name: "Orienteering", size: "", catalogNumber: "005200", computedNeeded: 2, needed: 0, edited: true, onHand: 0, toOrder: 0 },
  ],
  batches: [{ id: "b1", status: "ORDERED", createdAt: "2026-08-20T15:00:00.000Z", receivedAt: null, itemCount: 1, totalQuantity: 4, lines: [] }],
  unmatched: [{ sourceId: "s1", personId: "p1" }],
  awardable: [
    { needId: "n1", itemId: "i1", itemName: "Camping Skills", firstName: "Alex", lastName: "Sample", fromStock: false },
    { needId: "n2", itemId: "i1", itemName: "Camping Skills", firstName: "Jordan", lastName: "Example", fromStock: true },
  ],
  waiting: [
    { needId: "n2", sourceType: "HONOR", itemName: "Camping Skills", sourceLabel: "Camping Skills", sourceDate: "2025-05-01", firstName: "Jordan", lastName: "Example", beforeFirstOrder: true },
    { needId: "n3", sourceType: "HONOR", itemName: null, sourceLabel: "Orienteering", sourceDate: "2026-09-20", firstName: "Riley", lastName: "Test", beforeFirstOrder: false },
  ],
  firstOrderAt: null,
};

// No director edits yet: the state in which the one-time prompt is offered.
const clean: ClubOrderWorkspaceData = { ...data, helper: data.helper.map((line) => ({ ...line, edited: false, needed: line.computedNeeded })) };

const stock: ClubStockRow[] = [
  { itemId: "i1", section: "OUTDOOR_INDUSTRIES", name: "Camping Skills", catalogNumber: "005157", sizeLabel: null, isActive: true, quantityOnHand: 1 },
  { itemId: "x1", section: "MISCELLANEOUS", name: "Knot Tying Patch", catalogNumber: "002120", sizeLabel: null, isActive: true, quantityOnHand: 0 },
];

const render = (readOnly: boolean, initial = data) => renderToStaticMarkup(
  createElement(ClubOrderWorkspace, { organizationId: "club-1", initial, stock, printHref: "/account/clubs/club-1/orders/print", readOnly }),
);

describe("ClubOrderWorkspace (#654)", () => {
  it("is one Orders screen with the helper notice and an AdventSource link, not an order form", () => {
    const html = render(false);
    expect(html).toContain("<h2>Orders</h2>");
    expect(html).toContain("This is a helper to build your list");
    expect(html).toContain("<strong>not</strong> an official order form");
    expect(html).toContain("You still need to order the items from");
    expect(html).toContain(`href="${ADVENTSOURCE_URL}"`);
    expect(ADVENTSOURCE_URL).toBe("https://www.adventsource.org");
  });

  it("has no Place order button and no Orders placed history", () => {
    for (const readOnly of [false, true]) {
      const html = render(readOnly);
      expect(html).not.toContain("Place order");
      expect(html).not.toContain("Orders placed");
      expect(html).not.toContain("AdventSource file");
    }
  });

  it("shows a legacy order still waiting to arrive with Mark received for editors only, and nothing without one", () => {
    expect(render(false)).toContain("Orders waiting to arrive");
    expect(render(false)).toContain("Mark received");
    const viewer = render(true);
    expect(viewer).toContain("Orders waiting to arrive");
    expect(viewer).not.toContain("Mark received");
    const none = render(false, { ...data, batches: [{ ...data.batches[0], status: "RECEIVED" }] });
    expect(none).not.toContain("Orders waiting to arrive");
    expect(render(false, { ...data, batches: [] })).not.toContain("Mark received");
  });

  it("shows the calculated count next to a quantity that differs from it, and explains Available", () => {
    const html = render(false);
    expect(html).toContain("calculated: 2");
    expect(html).toContain("Available = in stock minus items set aside for someone.");
    expect(html).not.toContain("On hand</dt>");
  });

  it("lists Uniforms, then Honors, then other supplies, each line with name, size, item number and quantity", () => {
    const html = render(false);
    const uniforms = html.indexOf("<strong>Uniforms</strong>");
    const honors = html.indexOf("<strong>Honors</strong>");
    const other = html.indexOf("<strong>Other supplies and insignia</strong>");
    expect(uniforms).toBeGreaterThan(-1);
    expect(honors).toBeGreaterThan(uniforms);
    expect(other).toBeGreaterThan(honors);
    // A sized item is one line per size, each with its own item number.
    expect(html).toContain("Size M");
    expect(html).toContain("<code>011112</code>");
    expect(html).toContain("Size L");
    expect(html).toContain("<code>011113</code>");
    expect(html).toContain("Camping Skills");
    expect(html).toContain("<code>005157</code>");
    expect(html).toContain("Good Conduct Star");
  });

  it("shows needed, on hand, and to order on a line", () => {
    const html = render(true);
    expect(html).toContain("<dt>Quantity</dt><dd>3</dd>");
    expect(html).toContain("<dt>Available</dt><dd>1</dd>");
    expect(html).toContain("<dt>To order</dt><dd><strong>2</strong></dd>");
  });

  it("gives a director or deputy the edit controls: quantity, save, remove, add an item, export", () => {
    const html = render(false);
    expect(html).toContain('type="number"');
    expect(html).toContain("Save quantity: Camping Skills");
    expect(html).toContain("Remove from the list: Camping Skills");
    expect(html).toContain("Add an item");
    expect(html).toContain("Knot Tying Patch · 002120");
    expect(html).toContain("Mark handed out");
    expect(html).toContain("Reset to 2");
    expect(html).not.toContain("View only");
  });

  it("keeps a line a director took off the list visible so it can be put back, and out of the list", () => {
    const html = render(false);
    expect(html).toContain("Taken off the list");
    expect(html).toContain("Put back");
    expect(html).toContain("Orienteering");
    expect(html).not.toContain("Remove from the list: Orienteering");
  });

  it("shows a registrar or Area Coordinator the same list with no controls", () => {
    const html = render(true);
    expect(html).toContain("View only");
    expect(html).toContain("Camping Skills");
    expect(html).toContain("Alex Sample");
    expect(html).not.toContain("Add an item");
    expect(html).not.toContain("Save quantity");
    expect(html).not.toContain("Remove from the list");
    expect(html).not.toContain("Put back");
    expect(html).not.toContain("Mark handed out");
    expect(html).not.toContain('type="number"');
    // The only checkbox a viewer sees is the Inventory's own "Only items in stock" filter: none to pick people.
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
  });

  it("flags an item with no item number and an honor with no catalog item", () => {
    for (const readOnly of [false, true]) {
      const html = render(readOnly);
      expect(html).toContain("No item number");
      expect(html).toContain("no matching catalog item");
    }
  });

  it("offers the list export (CSV and printable) and the pick list", () => {
    const html = render(true);
    expect(html).toContain("/api/attendee/clubs/club-1/orders/csv?view=list");
    expect(html).toContain("/api/attendee/clubs/club-1/orders/csv?view=picklist");
    expect(html).toContain('href="/account/clubs/club-1/orders/print"');
  });

  it("has the Inventory sub-section inside Orders", () => {
    const html = render(false);
    expect(html).toContain('id="inventory"');
    expect(html).toContain("Inventory: supplies on hand");
    expect(html).toContain("Quantity on hand: Camping Skills");
  });

  it("disables the CSV export when nothing is on the list", () => {
    const html = render(false, { ...data, helper: [], awardable: [] });
    expect(html).toContain("Nothing on the list to export yet.");
    expect(html).not.toContain("/orders/csv?view=list");
    expect(html).not.toContain("/orders/print");
    expect(html).toContain('disabled=""');
  });

  it("marks a need stock already covers as ready to hand out from stock", () => {
    const html = render(false);
    expect(html).toContain("Jordan Example");
    expect(html).toContain("from stock");
  });

  it("offers editors the one-time 'already handed out' prompt for honors that may already be handed out", () => {
    const html = render(false, clean);
    expect(html).toContain("Honors that may already be handed out");
    expect(html).toContain("Mark the ones already handed out");
    expect(html).toContain("Select all (1)");
    expect(html).toContain("Completed before");
    // Only the need recorded before the first order is offered, and nothing is pre-checked.
    expect(html).not.toContain("Riley Test");
    expect(html).not.toMatch(/checked=""/);
    expect(render(true)).not.toContain("Already handed out");
    expect(render(true)).not.toContain("Honors that may already be handed out");
  });

  it("drops the prompt once the club has edited the helper list", () => {
    const edited = { ...data, helper: data.helper.map((line) => ({ ...line, edited: true })) };
    expect(render(false, edited)).not.toContain("Honors that may already be handed out");
  });

  it("shows names and items only, no other personal field", () => {
    const html = render(false);
    expect(html).not.toMatch(/birth|phone|email|guardian|allerg|medical|address/i);
  });
});

describe("Orders page jump links (#810)", () => {
  const nav = (html: string) => html.slice(html.indexOf('<nav aria-label="Jump to a part of this page"'), html.indexOf("</nav>", html.indexOf('<nav aria-label="Jump to a part of this page"')));

  it("puts a short anchor nav at the top, before the order list, in page order", () => {
    const html = render(false);
    expect(html.indexOf('id="club-order-sections"')).toBeGreaterThan(html.indexOf("<h2>Orders</h2>"));
    expect(html.indexOf('id="club-order-sections"')).toBeLessThan(html.indexOf("Your order list"));
    const links = [...nav(html).matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(links).toEqual(["club-order-list", "inventory", "club-order-waiting", "club-order-ready", "club-uniforms"]);
  });

  it("points every link at an element that exists, with the stable ids", () => {
    const html = render(false);
    for (const id of Object.values(ORDER_SECTION_IDS)) expect(html.match(new RegExp(`id="${id}"`, "g")), id).toHaveLength(1);
    // The older supplies redirects land on #inventory and #club-uniforms, so those never change.
    expect(ORDER_SECTION_IDS.supplies).toBe("inventory");
    expect(ORDER_SECTION_IDS.uniforms).toBe("club-uniforms");
  });

  it("leaves out Orders waiting to arrive when none is waiting, and still resolves every link", () => {
    const none = { ...data, batches: [] };
    const html = render(false, none);
    expect(nav(html)).not.toContain("club-order-waiting");
    expect(orderSectionLinks(false).map((link) => link.label)).toEqual(["Order list", "Supplies", "Ready to hand out", "Uniforms"]);
    for (const link of orderSectionLinks(false)) expect(html).toContain(`id="${link.id}"`);
  });

  it("shows the same nav to a view-only registrar", () => {
    expect(render(true)).toContain('href="#club-uniforms"');
  });
});
