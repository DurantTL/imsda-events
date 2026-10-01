/**
 * Pure helpers for the club form fill-in and meeting notes (#703): the
 * unsaved-changes check, the ranked-choice picker, and the note preview. Kept
 * free of React so they run in the node tests.
 */

type Answers = Record<string, unknown>;

export type ClubFormSnapshot = {
  answers: Answers;
  rosterMemberId: string;
  subjectName: string;
};

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isBlank);
  return false;
}

/** Key order and empty values never matter; array order does (it is a ranking). */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => !isBlank(item))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

export function clubFormIsDirty(current: ClubFormSnapshot, saved: ClubFormSnapshot): boolean {
  return JSON.stringify(normalize(current)) !== JSON.stringify(normalize(saved));
}

export const clubFormUnsavedMessage = "You have unsaved answers on this form. Leave this page and discard them?";

/** Most choices a ranked field accepts; the public form defaults to two. */
export function rankedMaximum(field: { maxSelections?: number; options: string[] }): number {
  return Math.max(1, Math.min(field.maxSelections ?? 2, field.options.length));
}

/**
 * Tap an option to rank it next in preference order; tap a ranked option to
 * drop it (later choices move up), so re-ranking is deselect then reselect.
 * A tap on an unranked option once the maximum is reached changes nothing.
 */
export function toggleRankedChoice(selected: string[], option: string, maximum: number): string[] {
  if (selected.includes(option)) return selected.filter((item) => item !== option);
  if (selected.length >= maximum) return selected;
  return [...selected, option];
}

export function rankLabel(rank: number): string {
  if (rank < 0) return "Choose";
  return rank === 0 ? "1st choice" : rank === 1 ? "2nd choice" : `#${rank + 1}`;
}

/** A one-line preview of a long note; null when the whole note already fits on one line. */
export function notePreview(text: string, limit = 140): string | null {
  const trimmed = text.trim();
  const flat = trimmed.replace(/\s+/g, " ");
  if (flat.length <= limit && !trimmed.includes("\n")) return null;
  const cut = flat.length > limit ? flat.slice(0, limit).replace(/\s+\S*$/, "") || flat.slice(0, limit) : flat;
  return `${cut}…`;
}
