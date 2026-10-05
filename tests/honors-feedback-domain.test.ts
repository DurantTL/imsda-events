import { describe, expect, it } from "vitest";
import {
  HONOR_PILL_COLLAPSE_LIMIT,
  filterRowsByPersonName,
  honorPillWindow,
  supersededInProgressEntryIds,
} from "@/modules/honors/member-honor-domain";

describe("supersededInProgressEntryIds (#790)", () => {
  it("replaces every un-voided in-progress entry newer than the latest completion", () => {
    expect(supersededInProgressEntryIds([
      { id: "e4", status: "IN_PROGRESS", voided: false },
      { id: "e3", status: "IN_PROGRESS", voided: true },
      { id: "e2", status: "IN_PROGRESS", voided: false },
      { id: "e1", status: "COMPLETED", voided: false },
      { id: "e0", status: "IN_PROGRESS", voided: false },
    ])).toEqual(["e4", "e2"]);
  });

  it("looks past a voided completion and returns nothing when there is nothing in progress", () => {
    expect(supersededInProgressEntryIds([
      { id: "e2", status: "COMPLETED", voided: true },
      { id: "e1", status: "IN_PROGRESS", voided: false },
    ])).toEqual(["e1"]);
    expect(supersededInProgressEntryIds([])).toEqual([]);
    expect(supersededInProgressEntryIds([{ id: "e1", status: "COMPLETED", voided: false }])).toEqual([]);
  });
});

describe("honorPillWindow (#790)", () => {
  const pills = (count: number) => Array.from({ length: count }, (_, index) => `honor-${index + 1}`);

  it("shows everything, with no toggle, up to the threshold", () => {
    expect(HONOR_PILL_COLLAPSE_LIMIT).toBe(6);
    const window = honorPillWindow(pills(6), false);
    expect(window).toMatchObject({ collapsible: false, hiddenCount: 0, total: 6 });
    expect(window.visible).toHaveLength(6);
    expect(honorPillWindow([], false)).toMatchObject({ collapsible: false, total: 0 });
  });

  it("collapses a longer list to the first six and reports how many are hidden", () => {
    const window = honorPillWindow(pills(15), false);
    expect(window.visible).toEqual(pills(6));
    expect(window).toMatchObject({ collapsible: true, hiddenCount: 9, total: 15 });
  });

  it("shows all when expanded but stays collapsible so Show fewer is offered", () => {
    const window = honorPillWindow(pills(7), true);
    expect(window.visible).toHaveLength(7);
    expect(window).toMatchObject({ collapsible: true, hiddenCount: 0 });
  });
});

describe("filterRowsByPersonName (#790)", () => {
  const rows = [
    { firstName: "Ana", lastName: "Rivera" },
    { firstName: "Mia", lastName: "Rivers-Stone" },
    { firstName: "Jo", lastName: "Chen" },
  ];

  it("matches case-insensitively on part of either name, in any order", () => {
    expect(filterRowsByPersonName(rows, "riv")).toHaveLength(2);
    expect(filterRowsByPersonName(rows, "RIVERA ana")).toEqual([rows[0]]);
    expect(filterRowsByPersonName(rows, "  jo  ")).toEqual([rows[2]]);
  });

  it("returns everyone for a blank search and no one for no match", () => {
    expect(filterRowsByPersonName(rows, "   ")).toEqual(rows);
    expect(filterRowsByPersonName(rows, "zzz")).toEqual([]);
  });
});
