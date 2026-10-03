/**
 * Sorting vocabulary shared by the attendee and member lists (#743): every list
 * says how it is ordered, and a sortable column shows its direction with
 * `aria-sort`. Pure and client-safe.
 */

export type SortDirection = "asc" | "desc";
export type AriaSortValue = "ascending" | "descending" | "none";

export function ariaSortValue(active: boolean, direction: SortDirection): AriaSortValue {
  if (!active) return "none";
  return direction === "asc" ? "ascending" : "descending";
}

export const flipDirection = (direction: SortDirection): SortDirection => (direction === "asc" ? "desc" : "asc");

/** "A to Z" / "oldest first" and so on, by what the column holds. */
export type SortKind = "text" | "date" | "number";

const directionWords: Record<SortKind, Record<SortDirection, string>> = {
  text: { asc: "A to Z", desc: "Z to A" },
  date: { asc: "oldest first", desc: "newest first" },
  number: { asc: "lowest first", desc: "highest first" },
};

/** The sentence a list shows about its order: "Sorted by last name, A to Z." */
export function sortOrderText(label: string, direction: SortDirection, kind: SortKind = "text"): string {
  return `Sorted by ${label}, ${directionWords[kind][direction]}.`;
}

type Named = { firstName?: string | null; lastName?: string | null };

const clean = (value: string | null | undefined) => (value ?? "").trim().toLocaleLowerCase("en-US");

/** Last name, then first name; a missing name sorts last either way. */
export function compareByName(left: Named, right: Named, direction: SortDirection = "asc"): number {
  const sign = direction === "asc" ? 1 : -1;
  const l = [clean(left.lastName), clean(left.firstName)];
  const r = [clean(right.lastName), clean(right.firstName)];
  const leftBlank = !l[0] && !l[1];
  const rightBlank = !r[0] && !r[1];
  if (leftBlank !== rightBlank) return leftBlank ? 1 : -1;
  return sign * (l[0].localeCompare(r[0], "en-US") || l[1].localeCompare(r[1], "en-US"));
}

/** A copy sorted by last then first name; the sort is stable, so ties keep their order. */
export function sortByName<T extends Named>(items: readonly T[], direction: SortDirection = "asc"): T[] {
  return [...items].sort((left, right) => compareByName(left, right, direction));
}

export const nameSortLabel = "last name";
