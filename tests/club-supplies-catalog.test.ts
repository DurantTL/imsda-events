import { describe, expect, it } from "vitest";
import {
  type ExistingCatalogHonor,
  type ExistingClubSupplyItem,
  clubSupplyCsvTemplate,
  clubSupplyImportFingerprint,
  parseClubSupplyCsv,
  planClubSupplyImport,
} from "@/modules/club-supplies/catalog-csv";
import {
  extractSizeLabel,
  honorCategoryForSection,
  normalizeClubSupplyName,
  resolveClubSupplySection,
} from "@/modules/club-supplies/domain";
import { resolveHonorCategory } from "@/modules/honors/domain";

const item = (overrides: Partial<ExistingClubSupplyItem> & Pick<ExistingClubSupplyItem, "id" | "section" | "name">): ExistingClubSupplyItem => ({
  normalizedName: normalizeClubSupplyName(overrides.name),
  catalogNumber: null,
  sizeLabel: null,
  isActive: true,
  honorId: null,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  ...overrides,
});

const honor = (id: string, code: string, name: string, extra: Partial<ExistingCatalogHonor> = {}): ExistingCatalogHonor => ({
  id, code, name, catalogNumber: null, category: null, updatedAt: new Date("2026-09-01T00:00:00Z"), ...extra,
});

describe("club supply names and sections (#531)", () => {
  it("normalizes names: trim, collapse, lower-case, & as and, drop a trailing (GC), and read '- Advanced' like ', Advanced'", () => {
    expect(normalizeClubSupplyName("  Bogs   &  Fens ")).toBe("bogs and fens");
    expect(normalizeClubSupplyName("Welding (GC)")).toBe("welding");
    expect(normalizeClubSupplyName("Bogs & Fens - Advanced")).toBe(normalizeClubSupplyName("Bogs and Fens, Advanced"));
    expect(normalizeClubSupplyName("Knots (GC) - Advanced")).toBe("knots, advanced");
    expect(normalizeClubSupplyName("Advanced Honor Star")).toBe("advanced honor star");
  });

  it("resolves the sheet's section text, including its 'Reacreation' typo and the honor categories", () => {
    expect(resolveClubSupplySection("Reacreation")).toBe("RECREATION");
    expect(resolveClubSupplySection("Arts, Crafts, And Hobbies")).toBe("ARTS_CRAFTS_AND_HOBBIES");
    expect(resolveClubSupplySection("Spiritual Growth, Outreach, And Heritage")).toBe("SPIRITUAL_GROWTH_OUTREACH_AND_HERITAGE");
    expect(resolveClubSupplySection("Master Awards")).toBe("MASTER_AWARDS");
    expect(resolveClubSupplySection("class a dress apparel")).toBe("CLASS_A_DRESS_APPAREL");
    expect(resolveClubSupplySection("Snacks")).toBeNull();
    expect(honorCategoryForSection("NATURE")).toBe("NATURE");
    expect(honorCategoryForSection("INVESTITURE")).toBeNull();
    expect(resolveHonorCategory("Health And Science")).toBe("HEALTH_AND_SCIENCE");
  });

  it("labels sizes without guessing", () => {
    expect(extractSizeLabel("Boys' Short Sleeve Shirt (S, Size 8, Chest 32)")).toBe("Size 8");
    expect(extractSizeLabel("White Parade Gloves (XL)")).toBe("XL");
    expect(extractSizeLabel("Crew sweatshirt X-Large")).toBe("X-Large");
    expect(extractSizeLabel("Sweatshirt Hoodie largee")).toBeNull();
    expect(extractSizeLabel("Friend Pin")).toBeNull();
  });
});

describe("club supply CSV parsing (#531)", () => {
  it("offers a template with an optional Active column", () => {
    expect(clubSupplyCsvTemplate().trim()).toBe('"Section","Item","Catalog Number","Active"');
  });

  it("keeps leading zeros, gives each size its own row and number, and flags bad rows", () => {
    const rows = parseClubSupplyCsv([
      "section,item,adventsource_catalog_number",
      "Other Apparel,Sweatshirt Hoodie Medium,008241",
      "Other Apparel,Sweatshirt Hoodie X-Large,008243",
      "Snacks,Granola,000001",
      ",Nameless,",
      "Nature,Birds - Advanced,",
      "Nature,Birds,005180",
    ].join("\n"));
    expect(rows.map((row) => [row.line, row.catalogNumber, row.sizeLabel])).toEqual([
      [2, "008241", "Medium"],
      [3, "008243", "X-Large"],
      [4, "000001", null],
      [5, null, null],
      [6, "007400", null],
      [7, "005180", null],
    ]);
    expect(rows[2].problems[0]).toMatch(/isn't a section/);
    expect(rows[3].problems[0]).toMatch(/needs a section/);
  });

  it("reads an optional Active column and leaves isActive unset without it", () => {
    const withColumn = parseClubSupplyCsv("Section,Item,Catalog Number,Active\nNature,Birds,005180,No\nNature,Bats,005170,maybe");
    expect(withColumn[0].isActive).toBe(false);
    expect(withColumn[1].problems[0]).toMatch(/Yes or No/);
    expect(parseClubSupplyCsv("Section,Item\nNature,Birds")[0].isActive).toBeUndefined();
  });

  it("rejects a file without the Section and Item columns", () => {
    expect(() => parseClubSupplyCsv("Name,Number\nBirds,1")).toThrow(/Section and Item/);
    expect(() => parseClubSupplyCsv("")).toThrow(/empty/);
  });
});

describe("club supply import plan (#531)", () => {
  const existing = [
    item({ id: "i-1", section: "INVESTITURE", name: "Friend Pin", catalogNumber: "002120" }),
    item({ id: "i-2", section: "MISCELLANEOUS", name: "Good Conduct Star (1st)", catalogNumber: "002305", isActive: false }),
    item({ id: "i-3", section: "CLASS_A_UNIFORM_ACCESSORIES", name: 'Belt & bucle 30"', catalogNumber: "008585" }),
  ];

  it("matches by section and normalized name, never by catalog number", () => {
    const plan = planClubSupplyImport(parseClubSupplyCsv([
      "section,item,adventsource_catalog_number",
      "Investiture,Friend Pin,002120",
      "Investiture,friend  pin,002120",
      "Miscellaneous,Good Conduct Star (2nd),002305",
      'Class A Uniform Accessories,"Belt & buckle 40""",008585',
      "Miscellaneous,Friend Pin,002120",
    ].join("\n")), existing, []);
    expect(plan.steps.map((step) => [step.action, step.itemId])).toEqual([
      ["SKIP", "i-1"],
      ["SKIP", "i-1"],
      ["ADD", null],
      ["ADD", null],
      ["ADD", null],
    ]);
    expect(plan.steps[1]).toMatchObject({ duplicateOfLine: 2 });
    expect(plan.summary).toMatchObject({ rows: 5, added: 3, updated: 0, skipped: 2, duplicates: 1 });
    // 002120 is on two distinct items in the file: a warning, not a skip. The merged repeat is not counted.
    expect(plan.repeatedNumbers.map((entry) => entry.catalogNumber).sort()).toEqual(["002120"]);
  });

  it("warns once per repeated number across distinct items", () => {
    const plan = planClubSupplyImport(parseClubSupplyCsv([
      "section,item,adventsource_catalog_number",
      "Miscellaneous,Good Conduct Star (1st),002305",
      "Miscellaneous,Good Conduct Star (2nd),002305",
      "Miscellaneous,Good Conduct Star (3rd),002305",
    ].join("\n")), [], []);
    expect(plan.summary.added).toBe(3);
    expect(plan.repeatedNumbers).toEqual([{ catalogNumber: "002305", count: 3, lines: [2, 3, 4] }]);
    expect(plan.summary.repeatedNumbers).toBe(1);
  });

  it("updates a changed number, and leaves isActive alone unless the Active column says otherwise", () => {
    const withoutActive = planClubSupplyImport(
      parseClubSupplyCsv("Section,Item,Catalog Number\nMiscellaneous,Good Conduct Star (1st),002305\nInvestiture,Friend Pin,002199"),
      existing,
      [],
    );
    expect(withoutActive.steps.map((step) => step.action)).toEqual(["SKIP", "UPDATE"]);
    expect(withoutActive.steps[1].write).toMatchObject({ catalogNumber: "002199", isActive: true });

    const withActive = planClubSupplyImport(
      parseClubSupplyCsv("Section,Item,Catalog Number,Active\nMiscellaneous,Good Conduct Star (1st),002305,Yes\nInvestiture,Friend Pin,002120,No"),
      existing,
      [],
    );
    expect(withActive.steps.map((step) => [step.action, step.write?.isActive])).toEqual([["UPDATE", true], ["UPDATE", false]]);
  });

  it("links honor rows to a matching honor, sets its number and category, and counts the unmatched", () => {
    const honors = [
      honor("h-1", "SYN-001", "Bogs and Fens"),
      honor("h-2", "SYN-002", "Bogs & Fens, Advanced"),
      honor("h-3", "SYN-003", "Birds (GC)", { catalogNumber: "005180", category: "NATURE" }),
    ];
    const plan = planClubSupplyImport(parseClubSupplyCsv([
      "section,item,adventsource_catalog_number",
      "Nature,Bogs & Fens,005157",
      "Nature,Bogs & Fens - Advanced,007400",
      "Nature,Birds,005180",
      "Nature,Unicorns,009999",
      "Master Awards,Naturalist Master Award,004050",
      "Investiture,Friend Pin,002120",
    ].join("\n")), [], honors);
    expect(plan.steps.map((step) => [step.honorMatch, step.write?.honorId ?? null, step.honorUpdate])).toEqual([
      ["MATCHED", "h-1", { honorId: "h-1", catalogNumber: "005157", category: "NATURE" }],
      ["MATCHED", "h-2", { honorId: "h-2", catalogNumber: "007400", category: "NATURE" }],
      ["MATCHED", "h-3", null],
      ["UNMATCHED", null, null],
      ["UNMATCHED", null, null],
      [null, null, null],
    ]);
    // Unmatched honors are still catalog items.
    expect(plan.steps.every((step) => step.action === "ADD")).toBe(true);
    expect(plan.summary).toMatchObject({ honorsMatched: 3, honorsUnmatched: 2, honorsUpdated: 2 });
  });
});

describe("club supply import fingerprint (#531)", () => {
  const rows = parseClubSupplyCsv("section,item,adventsource_catalog_number\nInvestiture,Friend Pin,002120");
  const items = [item({ id: "i-9", section: "NATURE", name: "Birds" })];
  const honors = [honor("h-1", "SYN-001", "Birds")];
  const fingerprint = (r = rows, i = items, h = honors) => clubSupplyImportFingerprint(planClubSupplyImport(r, i, h), i, h);

  it("is stable for the same file and catalog", () => {
    expect(fingerprint()).toBe(fingerprint());
    expect(fingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the file, an item, or an honor changes", () => {
    const base = fingerprint();
    expect(fingerprint(parseClubSupplyCsv("section,item,adventsource_catalog_number\nInvestiture,Friend Pin,002121"))).not.toBe(base);
    expect(fingerprint(rows, [{ ...items[0], updatedAt: new Date("2026-09-02T00:00:00Z") }])).not.toBe(base);
    expect(fingerprint(rows, items, [{ ...honors[0], catalogNumber: "005180" }])).not.toBe(base);
  });
});
