/** Pure helpers for how deleting an uploaded file affects the content
 * editor's sections. Kept free of React so they can be tested directly. */

import type {
  EventContentKind,
  EventContentPlacement,
  EventContentTone,
} from "@/modules/events/content-schemas";

export type LinkDraft = { label: string; description: string; url: string | null; assetId: string | null };
export type SectionDraft = {
  /** Stable client-side id, so a block's editor state follows it when blocks are reordered. Never sent. */
  cid?: string;
  /** The saved section's id, used to look up its server-sanitized HTML. Never sent. */
  serverId?: string;
  kind: EventContentKind;
  title: string;
  body: string;
  /** Info cards (#652). Optional so older drafts and fixtures stay valid. */
  tone?: EventContentTone | null;
  placement?: EventContentPlacement;
  items?: Array<{ title: string; text: string }>;
  /** Per-kind content of the #816 blocks. Absent for the older kinds. */
  data?: Record<string, unknown>;
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
      .filter((section) => (
        section.links.every((link) => link.assetId === assetId)
        && (section.kind === "RESOURCE_LINKS" || (section.kind === "NOTICE" && section.body.trim() === ""))
      ))
      .map(sectionLabel))],
  };
}

export function quoteList(titles: string[]) {
  return titles.map((title) => `“${title}”`).join(", ");
}

/** Whether a block may move by `delta`. The header banner is pinned at the top and nothing moves above it. */
export function canMoveSection(sections: Array<{ kind: string }>, index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= sections.length) return false;
  if (sections[index]?.kind === "HERO") return false;
  if (sections[target]?.kind === "HERO") return false;
  return true;
}

/** Moves a block, carrying its identity with it; a no-op when the move is not allowed. */
export function moveSection<T extends { kind: string }>(sections: T[], index: number, delta: number): T[] {
  if (!canMoveSection(sections, index, delta)) return sections;
  const next = [...sections];
  [next[index], next[index + delta]] = [next[index + delta], next[index]];
  return next;
}

/** What is sent to the server: the draft without its client-only ids (the schema refuses unknown keys). */
export function sectionPayload(section: SectionDraft) {
  const { cid, serverId, ...rest } = section;
  void cid;
  void serverId;
  return rest;
}
