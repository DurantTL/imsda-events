/** Pure helpers for how deleting an uploaded file affects the content
 * editor's sections. Kept free of React so they can be tested directly. */

export type LinkDraft = { label: string; description: string; url: string | null; assetId: string | null };
export type SectionDraft = {
  kind: "RICH_TEXT" | "RESOURCE_LINKS";
  title: string;
  body: string;
  isPublished: boolean;
  links: LinkDraft[];
};

/** Drops only the tiles that point at a deleted file, keeping every other
 * edit — used when the page has unsaved changes at the moment of a delete. */
export function withoutAssetTiles(sections: SectionDraft[], assetId: string): SectionDraft[] {
  return sections.map((section) => (
    section.links.some((link) => link.assetId === assetId)
      ? { ...section, links: section.links.filter((link) => link.assetId !== assetId) }
      : section
  ));
}

function sectionLabel(section: SectionDraft) {
  return section.title.trim() || "Untitled section";
}

/** What deleting a file would do to the editor's current, possibly unsaved,
 * sections: which lose a tile, and which would be left with no links. */
export function localAssetImpact(sections: SectionDraft[], assetId: string) {
  const affected = sections.filter((section) => section.links.some((link) => link.assetId === assetId));
  return {
    affectedTitles: [...new Set(affected.map(sectionLabel))],
    emptiedTitles: [...new Set(affected
      .filter((section) => section.kind === "RESOURCE_LINKS" && section.links.every((link) => link.assetId === assetId))
      .map(sectionLabel))],
  };
}

export function quoteList(titles: string[]) {
  return titles.map((title) => `“${title}”`).join(", ");
}
