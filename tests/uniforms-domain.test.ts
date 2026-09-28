import { describe, expect, it } from "vitest";
import { pickListCsv } from "@/modules/club-orders/domain";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";
import { entryTooLarge, groupUniformCatalog, isUniformSection, itemAndSize, splitSizedItemName, variantLabel } from "@/modules/uniforms/domain";
import { recordUniformNeedsSchema } from "@/modules/uniforms/schemas";

/** Uniform ordering (#497): sized catalog rows grouped for the picker, and the bulk entry schema. Synthetic data only. */

describe("splitSizedItemName (#497)", () => {
  it.each([
    ["Boys' Short Sleeve Shirt (S, Size 8)", "Boys' Short Sleeve Shirt", "S, Size 8"],
    ["Club Field Uniform (XL)", "Club Field Uniform", "XL"],
    ["Crew sweatshirt X-Large", "Crew sweatshirt", "X-Large"],
    ["Beret (M)", "Beret", "M"],
  ])("splits %s", (name, baseName, size) => {
    expect(splitSizedItemName(name)).toEqual({ baseName, size });
  });

  it("leaves a name with no reliable size whole", () => {
    expect(splitSizedItemName("Adult Scarf")).toEqual({ baseName: "Adult Scarf", size: "" });
    expect(splitSizedItemName("Sweatshirt Hoodie largee")).toEqual({ baseName: "Sweatshirt Hoodie largee", size: "" });
  });
});

describe("itemAndSize (#497)", () => {
  it("splits a uniform row but never an honor or other row", () => {
    expect(itemAndSize({ name: "Beret (L)", section: "TEEN_LEADERSHIP_TRAINING" })).toEqual({ itemName: "Beret", size: "L" });
    expect(itemAndSize({ name: "Mammals, Large", section: "NATURE" })).toEqual({ itemName: "Mammals, Large", size: "" });
    expect(itemAndSize({ name: "Camporee Patch (M)", section: "CAMPOREES" })).toEqual({ itemName: "Camporee Patch (M)", size: "" });
  });

  it("knows which sections are uniforms", () => {
    expect(isUniformSection("CLASS_A_DRESS_APPAREL")).toBe(true);
    expect(isUniformSection("NATURE")).toBe(false);
  });
});

describe("groupUniformCatalog (#497)", () => {
  const rows = [
    { itemId: "shirt-xl", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (XL)", catalogNumber: "011114" },
    { itemId: "shirt-s", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (S)", catalogNumber: "011111" },
    { itemId: "shirt-m", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (M)", catalogNumber: "011112" },
    { itemId: "shirt-l", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (L)", catalogNumber: "011113" },
    { itemId: "scarf", section: "CLASS_A_UNIFORM_ACCESSORIES", name: "Adult Scarf", catalogNumber: "020001" },
    { itemId: "honor", section: "NATURE", name: "Birds", catalogNumber: "005000" },
    { itemId: "field-m", section: "OTHER_APPAREL", name: "Club Field Uniform (M)", catalogNumber: "030002" },
  ];

  it("groups size variants under the base name, in size order, and skips non-uniform rows", () => {
    const groups = groupUniformCatalog(rows);
    expect(groups.map((group) => group.baseName)).toEqual(["Boys' Short Sleeve Shirt", "Adult Scarf", "Club Field Uniform"]);
    expect(groups[0].variants.map((variant) => variant.size)).toEqual(["S", "M", "L", "XL"]);
    expect(groups[0].variants.map((variant) => variant.itemId)).toEqual(["shirt-s", "shirt-m", "shirt-l", "shirt-xl"]);
    expect(groups[0].sectionLabel).toBe("Class A Dress Apparel");
    expect(groups.flatMap((group) => group.variants.map((variant) => variant.itemId))).not.toContain("honor");
  });

  it("gives an unsized item a single 'One size' variant", () => {
    const scarf = groupUniformCatalog(rows).find((group) => group.baseName === "Adult Scarf")!;
    expect(scarf.variants).toHaveLength(1);
    expect(variantLabel(scarf.variants[0])).toBe("One size");
  });

  it("keeps the same name in two sections apart", () => {
    const groups = groupUniformCatalog([
      { itemId: "a", section: "CLASS_A_DRESS_APPAREL", name: "Belt (30\")", catalogNumber: null },
      { itemId: "b", section: "OTHER_APPAREL", name: "Belt (M)", catalogNumber: null },
    ]);
    expect(groups.map((group) => group.section)).toEqual(["CLASS_A_DRESS_APPAREL", "OTHER_APPAREL"]);
  });
});

describe("the pick list for a uniform (#497)", () => {
  it("has the name, item, and size and nothing else personal", () => {
    const { itemName, size } = itemAndSize({ name: "Club Field Uniform (M)", section: "OTHER_APPAREL" });
    const rows = parseCsvMatrix(pickListCsv([{ lastName: "Sample", firstName: "Alex", itemName, size, status: "Ordered" }]));
    expect(rows[0]).toEqual(["Last name", "First name", "Item", "Size", "Status"]);
    expect(rows[1]).toEqual(["Sample", "Alex", "Club Field Uniform", "M", "Ordered"]);
  });
});

describe("entryTooLarge (#497)", () => {
  it("allows exactly the cap and no more", () => {
    expect(entryTooLarge(50, 20)).toBe(false);
    expect(entryTooLarge(51, 20)).toBe(true);
    expect(entryTooLarge(12, 2)).toBe(false);
  });
});

describe("recordUniformNeedsSchema (#497)", () => {
  it("accepts members x items and defaults 'already has one' to false", () => {
    expect(recordUniformNeedsSchema.parse({ personIds: ["p1", "p2"], itemIds: ["scarf", "slide"] })).toEqual({
      personIds: ["p1", "p2"], itemIds: ["scarf", "slide"], alreadyHasOne: false,
    });
  });

  it("refuses empty lists, extra fields, and an oversized entry", () => {
    expect(recordUniformNeedsSchema.safeParse({ personIds: [], itemIds: ["a"] }).success).toBe(false);
    expect(recordUniformNeedsSchema.safeParse({ personIds: ["p"], itemIds: [] }).success).toBe(false);
    expect(recordUniformNeedsSchema.safeParse({ personIds: ["p"], itemIds: ["a"], organizationId: "other" }).success).toBe(false);
    const people = Array.from({ length: 100 }, (_, index) => `p${index}`);
    const items = Array.from({ length: 20 }, (_, index) => `i${index}`);
    expect(recordUniformNeedsSchema.safeParse({ personIds: people, itemIds: items }).success).toBe(false);
  });
});
