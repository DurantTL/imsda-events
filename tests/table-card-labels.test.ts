import { describe, expect, it } from "vitest";
import { cardLabelsFromHeaders, isLongCardLabel } from "@/components/table-card-labels";

describe("phone table card labels (#686)", () => {
  it("uses the header text as each cell's label and collapses whitespace", () => {
    expect(cardLabelsFromHeaders([
      { text: "Club", hiddenOnly: false },
      { text: "  Reports\n  submitted ", hiddenOnly: false },
    ])).toEqual(["Club", "Reports submitted"]);
  });

  it("gives no label to a screen-reader-only or empty header column", () => {
    expect(cardLabelsFromHeaders([
      { text: "Actions", hiddenOnly: true },
      { text: "", hiddenOnly: false },
    ])).toEqual([null, null]);
  });

  it("flags labels too long for the side-by-side gutter", () => {
    expect(isLongCardLabel("Church")).toBe(false);
    expect(isLongCardLabel("Background checks")).toBe(true);
  });
});
