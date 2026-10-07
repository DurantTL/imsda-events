import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ClubEarnedAwardsWorkspace, completionPayload, emptyEarnedAwardsData } from "@/components/club-earned-awards-workspace";
import { HonorCombobox } from "@/components/honor-combobox";
import { clubClassLevelLabels, clubClassLevels } from "@/modules/club-rosters/domain";
import { filterHonorsByWordPrefix } from "@/modules/honors/honor-search";

/** The class tracking page's type-to-search class picker (#827). Synthetic data only. */
const levels = clubClassLevels.map((level) => ({ id: level, name: clubClassLevelLabels[level] }));
const members = [{ personId: "p1", firstName: "Alex", lastName: "Sample", classLabel: "Friend" }];

describe("class tracking class picker (#827)", () => {
  it("renders a combobox, not a select, for the class, showing the chosen class", () => {
    const html = renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
      organizationId: "club-1", ordersHref: "/o", initial: { ...emptyEarnedAwardsData, members },
    }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="Friend"');
    expect(html).toContain("Class matches");
    expect(html).not.toContain('id="earned-class-level"');
    expect(html).toContain("Mark completed");
  });

  it("is not offered to a view-only visitor", () => {
    const html = renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
      organizationId: "club-1", ordersHref: "/o", readOnly: true, initial: { ...emptyEarnedAwardsData, members },
    }));
    expect(html).not.toContain('role="combobox"');
  });

  it("searches class names from the start of any word", () => {
    expect(filterHonorsByWordPrefix(levels, "ma").map((level) => level.id)).toEqual(["MASTER_GUIDE"]);
    expect(filterHonorsByWordPrefix(levels, "gui").map((level) => level.id)).toEqual(["GUIDE", "MASTER_GUIDE"]);
    expect(filterHonorsByWordPrefix(levels, "uide")).toEqual([]);
  });

  it("uses class wording, and keeps honor wording by default", () => {
    const classes = renderToStaticMarkup(createElement(HonorCombobox, { label: "Class", noun: "class", nounPlural: "classes", onChange: () => {}, options: levels, value: "GUIDE" }));
    expect(classes).toContain("Type to search classes");
    expect(classes).toContain('value="Guide"');
    const honors = renderToStaticMarkup(createElement(HonorCombobox, { label: "Honor", onChange: () => {}, options: [], value: "" }));
    expect(honors).toContain("Type to search honors");
    expect(honors).toContain("No honor matches");
    expect(classes).not.toContain("No honor matches");
  });

  it("still posts the chosen class level with the shown, selected members", () => {
    expect(completionPayload(members, new Set(["p1"]), "", "GUIDE", "2026-06-06")).toEqual({ personIds: ["p1"], classLevel: "GUIDE", completedOn: "2026-06-06" });
  });
});
