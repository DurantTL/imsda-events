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
  // false is the same as unset, so checking then unchecking a box is not a change.
  if (value === undefined || value === null || value === "" || value === false) return true;
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

/** Ranked answers keep only choices still offered; others would be rejected on submit. */
export function dropStaleRankedChoices(
  definition: { sections: Array<{ fields: Array<{ key: string; type: string; options: string[] }> }> },
  answers: Answers,
): Answers {
  let result = answers;
  for (const section of definition.sections) {
    for (const field of section.fields) {
      const value = result[field.key];
      if (field.type !== "RANKED_CHOICE" || !Array.isArray(value)) continue;
      const kept = value.map(String).filter((item) => field.options.includes(item));
      if (kept.length !== value.length) result = { ...result, [field.key]: kept };
    }
  }
  return result;
}

/**
 * A one-line preview of a note: its first line, with "…" only when something
 * is hidden (more lines, or a first line cut at a word). Null when the whole
 * note is one short line.
 */
export function notePreview(text: string, limit = 140): string | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = (lines[0] ?? "").replace(/\s+/g, " ");
  const hiddenLines = lines.length > 1;
  if (first.length <= limit) return hiddenLines ? `${first}…` : null;
  const cut = first.slice(0, limit).replace(/\s+\S*$/, "") || first.slice(0, limit);
  return `${cut}…`;
}

type AutoDateField = { key: string; type: string; autoDate?: string };

/**
 * Fills in today's date (#719) for every auto-date field without an answer
 * (a director's new form), or for every one of them when `overwrite` is set
 * (a private link, where the server sets the same day again on submit).
 */
export function withAutoDateAnswers(
  definition: { sections: Array<{ fields: AutoDateField[] }> },
  answers: Answers,
  today: string,
  overwrite = false,
): Answers {
  const next = { ...answers };
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (field.type !== "DATE" || field.autoDate !== "TODAY") continue;
      if (overwrite || isBlank(next[field.key])) next[field.key] = today;
    }
  }
  return next;
}
