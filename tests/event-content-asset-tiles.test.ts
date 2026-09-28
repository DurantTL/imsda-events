import { describe, expect, it } from "vitest";
import {
  localAssetImpact,
  withoutAssetTiles,
  type SectionDraft,
} from "@/components/event-content-asset-tiles";

function resources(title: string, assetIds: Array<string | null>): SectionDraft {
  return {
    kind: "RESOURCE_LINKS",
    title,
    body: "",
    isPublished: false,
    links: assetIds.map((assetId, index) => ({
      label: `Tile ${index + 1}`,
      description: "",
      url: assetId ? null : "https://example.test/page",
      assetId,
    })),
  };
}

describe("withoutAssetTiles", () => {
  it("strips only the deleted file's tiles and keeps every other unsaved edit", () => {
    const edited = [
      { ...resources("Retreat resources", ["asset-gone", null, "asset-kept"]), body: "unsaved note" },
      { kind: "RICH_TEXT" as const, title: "Schedule", body: "Friday", isPublished: true, links: [] },
    ];

    const next = withoutAssetTiles(edited, "asset-gone");

    expect(JSON.stringify(next)).not.toContain("asset-gone");
    expect(next[0].links.map((link) => link.label)).toEqual(["Tile 2", "Tile 3"]);
    expect(next[0].body).toBe("unsaved note");
    expect(next[1]).toBe(edited[1]);
  });
});

describe("localAssetImpact", () => {
  it("names sections that lose a tile and those that would be left with no links", () => {
    const impact = localAssetImpact([
      resources("Retreat resources", ["asset-1", null]),
      resources("Maps", ["asset-1"]),
      resources("Unrelated", [null]),
    ], "asset-1");

    expect(impact.affectedTitles).toEqual(["Retreat resources", "Maps"]);
    expect(impact.emptiedTitles).toEqual(["Maps"]);
  });
});
