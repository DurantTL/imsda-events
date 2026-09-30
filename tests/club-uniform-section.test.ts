import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubOrderWorkspace, type ClubOrderWorkspaceData } from "@/components/club-order-workspace";
import type { ClubUniformData } from "@/components/club-uniform-section";
import { groupUniformCatalog } from "@/modules/uniforms/domain";

/**
 * The Uniforms section of the order screen (#497), initial-render markup.
 * Synthetic data only.
 */

const orders: ClubOrderWorkspaceData = {
  helper: [
    { itemId: "scarf", section: "UNIFORMS", name: "Adult Scarf", size: "", catalogNumber: "020001", computedNeeded: 2, needed: 2, edited: false, onHand: 0, toOrder: 2 },
  ],
  unmatched: [],
  batches: [],
  awardable: [],
  waiting: [
    { needId: "u1", sourceType: "UNIFORM", itemName: "Adult Scarf", sourceLabel: "Adult Scarf", sourceDate: "2026-09-28", firstName: "Alex", lastName: "Sample", beforeFirstOrder: true },
  ],
  firstOrderAt: null,
};

const uniforms: ClubUniformData = {
  catalog: groupUniformCatalog([
    { itemId: "shirt-s", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (S)", catalogNumber: "011111" },
    { itemId: "shirt-m", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (M)", catalogNumber: "011112" },
    { itemId: "scarf", section: "CLASS_A_UNIFORM_ACCESSORIES", name: "Adult Scarf", catalogNumber: "020001" },
  ]),
  members: [
    { personId: "p1", firstName: "Alex", lastName: "Sample" },
    { personId: "p2", firstName: "Casey", lastName: "Demo" },
  ],
  needs: [
    { needId: "u1", personId: "p1", firstName: "Alex", lastName: "Sample", itemName: "Adult Scarf", size: "", status: "NEEDED" },
    { needId: "u2", personId: "p2", firstName: "Casey", lastName: "Demo", itemName: "Boys' Short Sleeve Shirt", size: "M", status: "ORDERED" },
  ],
  issuedCount: 3,
};

const render = (readOnly: boolean, data: ClubUniformData = uniforms) => renderToStaticMarkup(
  createElement(ClubOrderWorkspace, { organizationId: "club-1", initial: orders, initialUniforms: data, readOnly }),
);

describe("the Uniforms section (#497)", () => {
  it("gives a director or deputy the bulk entry: grouped item and size pickers, members, and 'already has one'", () => {
    const html = render(false);
    expect(html).toContain("Uniforms");
    expect(html).toContain("Record uniform needs");
    // Size variants are grouped under the base item name, in an optgroup per catalog section.
    expect(html).toContain('<optgroup label="Class A Dress Apparel">');
    expect(html.match(/Boys&#x27; Short Sleeve Shirt<\/option>/g)).toHaveLength(1);
    expect(html).toContain("Add item");
    expect(html).toContain("Select all");
    expect(html).toContain("They already have one");
    expect(html).toContain("Record needs");
    expect(html).toContain("Alex Sample");
    expect(html).toContain("Casey Demo");
  });

  it("lists open needs with their status, and offers the row actions only for ones not yet ordered", () => {
    const html = render(false);
    expect(html).toContain("Open uniform needs (2)");
    expect(html).toContain("Needed");
    expect(html).toContain("Ordered");
    expect(html).toContain("3 issued so far");
    expect(html).toContain("Already has one");
    expect(html).toContain("Remove");
    // The ordered need is plain text: only the NEEDED one has a checkbox in that list.
    expect(html).toContain("Boys&#x27; Short Sleeve Shirt, M");
  });

  it("shows a registrar or Area Coordinator the needs and no controls", () => {
    const html = render(true, { ...uniforms, catalog: [], members: [] });
    expect(html).toContain("Open uniform needs (2)");
    expect(html).toContain("Alex Sample");
    expect(html).not.toContain("Record uniform needs");
    expect(html).not.toContain("Record needs");
    expect(html).not.toContain("Add item");
    expect(html).not.toContain("Already has one");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain('type="checkbox"');
  });

  it("does not offer the honors 'may already be handed out' prompt for uniform needs", () => {
    expect(render(false)).not.toContain("Honors that may already be handed out");
  });

  it("shows names, items and sizes only, no other personal field", () => {
    for (const readOnly of [false, true]) {
      expect(render(readOnly)).not.toMatch(/birth|phone|email|guardian|allerg|medical|address/i);
    }
  });

  it("explains an empty catalog to a director", () => {
    expect(render(false, { ...uniforms, catalog: [] })).toContain("No uniform items are in the supply catalog yet");
  });
});
