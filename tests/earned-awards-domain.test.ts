import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AWARD_SECTIONS,
  awardEntryTooLarge,
  classInsigniaSourceId,
  eventPatchSourceId,
  evaluateMasterAward,
  INSIGNIA_SETS,
  isAwardSection,
  masterAwardSourceId,
  matchInsigniaSet,
  originOf,
  progressLabel,
  ruleReadinessProblems,
} from "@/modules/earned-awards/domain";
import {
  MasterAwardRulesFileError,
  masterAwardImportFingerprint,
  parseMasterAwardRulesFile,
  planMasterAwardImport,
} from "@/modules/earned-awards/master-award-import";
import { parseClubSupplyCsv } from "@/modules/club-supplies/catalog-csv";

/** Earned awards pure rules (#532). Synthetic data, plus the two committed reference files. */

describe("class insignia sets", () => {
  const catalogRows = parseClubSupplyCsv(readFileSync("docs/reference/adventsource-club-catalog.csv", "utf8"))
    .filter((row) => row.section === "INVESTITURE")
    .map((row, index) => ({ itemId: `item-${index}`, section: row.section as string, name: row.name, catalogNumber: row.catalogNumber ?? null }));

  it("finds every class's set in the real catalog by section plus name, with nothing missing", () => {
    for (const level of ["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE", "MASTER_GUIDE"] as const) {
      const { items, missing } = matchInsigniaSet(level, catalogRows);
      expect(missing, level).toEqual([]);
      expect(items.length, level).toBe(INSIGNIA_SETS[level].length);
    }
    expect(matchInsigniaSet("FRIEND", catalogRows).items.map((item) => item.name)).toEqual([
      "Friend Class Name Strip", "Friend Chevron", "Friend Pin", "Trail Friend Ribbon Bar",
    ]);
  });

  it("suggests a name strip, chevron, pin and ribbon bar for each youth class", () => {
    for (const level of ["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE"] as const) {
      const names = INSIGNIA_SETS[level];
      expect(names).toHaveLength(4);
      expect(names[0]).toMatch(/Class Name Strip$/);
      expect(names[1]).toMatch(/Chevron$/);
      expect(names[2]).toMatch(/Pin$/);
      expect(names[3]).toMatch(/Ribbon Bar$/);
    }
  });

  it("flags set items the catalog lacks instead of dropping them, and ignores other sections and unmatched names", () => {
    const rows = [
      { itemId: "a", section: "INVESTITURE", name: "Friend Pin" },
      { itemId: "b", section: "MISCELLANEOUS", name: "Friend Chevron" },
      { itemId: "c", section: "INVESTITURE", name: "friend  class name strip" },
    ];
    const { items, missing } = matchInsigniaSet("FRIEND", rows);
    expect(items.map((item) => item.itemId)).toEqual(["c", "a"]);
    expect(missing).toEqual(["Friend Chevron", "Trail Friend Ribbon Bar"]);
    expect(matchInsigniaSet("TLT", rows)).toEqual({ items: [], missing: [] });
  });
});

describe("need keys and sections", () => {
  it("keys suggested needs on what earned them, so a repeat can never make a second need", () => {
    expect(classInsigniaSourceId("p1", "FRIEND", "i1")).toBe("class:p1:FRIEND:i1");
    expect(eventPatchSourceId("e1", "p1", "i1")).toBe("event:e1:p1:i1");
    expect(masterAwardSourceId("p1", "r1")).toBe("master:p1:r1");
    expect(originOf("class:p1:FRIEND:i1")).toBe("Class insignia");
    expect(originOf("event:e1:p1:i1")).toBe("Event patch");
    expect(originOf("master:p1:r1")).toBe("Master Award");
    expect(originOf("award:abc")).toBe("Added by hand");
  });

  it("offers earned-award sections only: never honors or apparel", () => {
    for (const section of ["INVESTITURE", "CAMPOREES", "PATHFINDER_BIBLE_EXPERIENCE", "TEEN_LEADERSHIP_TRAINING", "MISCELLANEOUS", "MASTER_AWARDS"]) {
      expect(isAwardSection(section), section).toBe(true);
    }
    for (const section of ["NATURE", "CLASS_A_DRESS_APPAREL", "OTHER_APPAREL", "MISCELLANEOUS_HONORS"]) {
      expect(isAwardSection(section), section).toBe(false);
    }
    expect(AWARD_SECTIONS).toHaveLength(6);
    expect(awardEntryTooLarge(50, 20)).toBe(false);
    expect(awardEntryTooLarge(51, 20)).toBe(true);
  });
});

describe("Master Award eligibility", () => {
  const health = {
    groups: [
      { minimum: 3, honorIds: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"] },
      { minimum: 2, honorIds: ["b1", "b2", "b3", "b4", "b5"] },
      { minimum: 2, honorIds: ["c1", "c2", "c3", "c4", "c5"] },
    ],
  };

  it("is earned only when every group reaches its minimum", () => {
    const all = evaluateMasterAward(health, new Set(["a1", "a2", "a3", "b1", "b2", "c1", "c2"]));
    expect(all.earned).toBe(true);
    expect(progressLabel(all)).toBe("7 of 7");
    // Plenty of honors in two groups but none in the third: not earned.
    const lopsided = evaluateMasterAward(health, new Set(["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3"]));
    expect(lopsided.earned).toBe(false);
    expect(lopsided.groups.map((group) => group.met)).toEqual([true, true, false]);
    expect(progressLabel(lopsided)).toBe("5 of 7");
  });

  it("caps each group at its own minimum when counting progress, and counts a group's honors once", () => {
    const progress = evaluateMasterAward(health, new Set(["a1", "a2", "a3", "a4", "a5", "a6", "b1"]));
    expect(progress.counted).toBe(4);
    expect(progress.required).toBe(7);
    expect(progress.groups[0]).toMatchObject({ have: 6, minimum: 3, total: 7, met: true });
    const duplicated = evaluateMasterAward({ groups: [{ minimum: 2, honorIds: ["x", "x", "y"] }] }, new Set(["x"]));
    expect(duplicated.groups[0]).toMatchObject({ have: 1, total: 2, met: false });
  });

  it("handles the single-group 'any N of M' rules and a rule with no groups", () => {
    const aquatic = { groups: [{ minimum: 7, honorIds: Array.from({ length: 16 }, (_, index) => `h${index}`) }] };
    expect(evaluateMasterAward(aquatic, new Set(["h0", "h1", "h2", "h3", "h4", "h5"])).earned).toBe(false);
    expect(evaluateMasterAward(aquatic, new Set(["h0", "h1", "h2", "h3", "h4", "h5", "h6"])).earned).toBe(true);
    expect(evaluateMasterAward({ groups: [] }, new Set(["h0"])).earned).toBe(false);
  });

  it("counts an honor in each group it appears in, as the club's sheet does", () => {
    const overlap = { groups: [{ minimum: 1, honorIds: ["s"] }, { minimum: 1, honorIds: ["s", "t"] }] };
    expect(evaluateMasterAward(overlap, new Set(["s"])).earned).toBe(true);
  });

  it("only lets a ready rule be activated", () => {
    expect(ruleReadinessProblems({ needsManualCheck: false, groups: [{ minimum: 2, honorIds: ["a", "b"] }] })).toEqual([]);
    expect(ruleReadinessProblems({ needsManualCheck: true, groups: [{ minimum: 2, honorIds: ["a", "b"] }] })).toHaveLength(1);
    expect(ruleReadinessProblems({ needsManualCheck: false, groups: [] })).toEqual(["Add at least one honor group."]);
    expect(ruleReadinessProblems({ needsManualCheck: false, groups: [{ minimum: 3, honorIds: ["a", "a", "b"] }] })[0]).toMatch(/needs 3 but lists only 2/);
    expect(ruleReadinessProblems({ needsManualCheck: false, groups: [{ minimum: 0, honorIds: ["a"] }] })[0]).toMatch(/at least 1/);
  });
});

describe("the committed Master Award rules file", () => {
  const text = readFileSync("docs/reference/master-award-rules.json", "utf8");
  const seeds = parseMasterAwardRulesFile(text);

  it("holds the 15 rules the club's formulas parsed to, honor names and minimums only", () => {
    expect(seeds).toHaveLength(15);
    const byName = Object.fromEntries(seeds.map((seed) => [seed.name, seed.groups.map((group) => [group.minimum, group.honors.length])]));
    expect(byName["Aquatic Master Award"]).toEqual([[7, 16]]);
    expect(byName["Health Master Award"]).toEqual([[3, 7], [2, 5], [2, 5]]);
    expect(byName["Naturalist Master Award"]).toEqual([[4, 17], [2, 16], [1, 6]]);
    // Nothing but the two documented keys per rule, and nothing that looks like a person.
    for (const rule of Object.values(JSON.parse(text)) as Array<Record<string, unknown>>) {
      expect(Object.keys(rule).sort()).toEqual(["groups", "groupsRequired"]);
    }
    expect(text).not.toMatch(/@|birth|phone|address/i);
  });

  it("plans every rule as new, flags Family, Origins, and Heritage, and lists honors that match nothing", () => {
    const honors = [{ id: "h-swim", name: "Swimming", isActive: true }, { id: "h-swim-adv", name: "Swimming, Advanced", isActive: true }];
    const items = [{ id: "i-aq", name: "Aquatic Master Award" }];
    const plan = planMasterAwardImport(seeds, new Set(), honors, items);
    expect(plan.summary.added).toBe(15);
    expect(plan.summary.existing).toBe(0);
    const family = plan.steps.find((step) => step.name.startsWith("Family, Origins"))!;
    expect(family.needsManualCheck).toBe(true);
    expect(family.reasons.join(" ")).toMatch(/Parsed only partly/);
    const aquatic = plan.steps.find((step) => step.name === "Aquatic Master Award")!;
    expect(aquatic.itemId).toBe("i-aq");
    // "Swimming - Advanced" reads as "Swimming, Advanced" and matches; the rest of the sheet's honors don't, with this tiny list.
    expect(aquatic.groups[0].honorIds.sort()).toEqual(["h-swim", "h-swim-adv"]);
    expect(plan.unmatched.length).toBeGreaterThan(0);
    expect(plan.unmatched.every((entry) => entry.award && entry.honor)).toBe(true);
  });

  it("leaves rules already on file alone, so a re-run never overwrites an edit", () => {
    const existing = new Set(seeds.slice(0, 3).map((seed) => seed.name.toLowerCase()));
    const plan = planMasterAwardImport(seeds, existing, [], []);
    expect(plan.summary).toMatchObject({ added: 12, existing: 3 });
    expect(plan.steps.filter((step) => step.action === "EXISTS")).toHaveLength(3);
  });

  it("changes its fingerprint when the honor list or the file changes", () => {
    const honors = [{ id: "h1", name: "Swimming", isActive: true }];
    const one = masterAwardImportFingerprint(planMasterAwardImport(seeds, new Set(), [], []));
    const again = masterAwardImportFingerprint(planMasterAwardImport(seeds, new Set(), [], []));
    const changed = masterAwardImportFingerprint(planMasterAwardImport(seeds, new Set(), honors, []));
    expect(again).toBe(one);
    expect(changed).not.toBe(one);
  });
});

describe("parsing a rules file", () => {
  const rule = { groups: [{ minimum: 2, honors: ["A", "B", "C"] }], groupsRequired: 1 };

  it("accepts a well-formed file", () => {
    expect(parseMasterAwardRulesFile(JSON.stringify({ "Test Award": rule }))).toEqual([
      { name: "Test Award", groupsRequired: 1, groups: [{ minimum: 2, honors: ["A", "B", "C"] }] },
    ]);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an empty file", "{}"],
    ["a rule with no groups", JSON.stringify({ X: { groups: [], groupsRequired: 1 } })],
    ["a zero minimum", JSON.stringify({ X: { groups: [{ minimum: 0, honors: ["A"] }], groupsRequired: 1 } })],
    ["an unknown key (something that could carry a member's data)", JSON.stringify({ X: { ...rule, member: "Someone" } })],
    ["a group with no honors", JSON.stringify({ X: { groups: [{ minimum: 1, honors: [] }], groupsRequired: 1 } })],
    ["the same award twice, however spelled", JSON.stringify({ "Test Award": rule, "test  award": rule })],
  ])("refuses %s", (_label, body) => {
    expect(() => parseMasterAwardRulesFile(body)).toThrow(MasterAwardRulesFileError);
  });
});
