/**
 * The calendar admin's Entries list (#796): search, filters, sorting and the
 * rules for bulk actions. Pure, so the page and the bulk endpoint share one
 * definition and tests need no database.
 */

import { expandOccurrences, type RepeatRule } from "@/modules/calendar/recurrence";

/** The most entries the admin list loads (newest start dates first). */
export const calendarEntryListLimit = 1000;

export type AdminListEntry = {
  id: string;
  title: string;
  description: string;
  location: string;
  category: string;
  startsOn: string;
  endsOn: string;
  entryType: "STANDARD" | "CLOSURE";
  isPublished: boolean;
  isHiddenLocally: boolean;
  sourceFeedId: string | null;
  sourceRemovedAt: string | Date | null;
  repeat?: RepeatRule | null;
  repeatExceptions?: readonly string[];
};

export const noCategoryFilter = "__none__";
export const staffSourceFilter = "__staff__";

export type EntryStateFilter = "all" | "published" | "draft" | "hidden" | "removed";
export type EntryTimeFilter = "upcoming" | "past" | "all";
export type EntrySort = "date" | "title" | "category";

export type EntryFilters = {
  search: string;
  /** "" = any, `noCategoryFilter` = no category, otherwise the category name. */
  category: string;
  /** "" = any, `staffSourceFilter` = staff-made, otherwise an imported feed's id. */
  source: string;
  state: EntryStateFilter;
  time: EntryTimeFilter;
  entryType: "" | "STANDARD" | "CLOSURE";
};

export const defaultEntryFilters: EntryFilters = { search: "", category: "", source: "", state: "all", time: "upcoming", entryType: "" };

export const entrySortLabels: Record<EntrySort, string> = {
  date: "date, soonest first",
  title: "title, A to Z",
  category: "category, A to Z (no category last)",
};

/** Case-insensitive match on title, location and description; a blank search matches everything. */
export function matchesSearch(entry: Pick<AdminListEntry, "title" | "location" | "description">, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [entry.title, entry.location, entry.description].some((field) => field.toLowerCase().includes(needle));
}

/**
 * Upcoming = not over yet on `today` (YYYY-MM-DD). A repeating entry is
 * upcoming while any of its occurrences (skipped dates excluded) ends today or
 * later: one with no end always is, and one ended by a date or a count is
 * checked against its real last occurrence.
 */
export function isUpcoming(entry: Pick<AdminListEntry, "startsOn" | "endsOn" | "repeat" | "repeatExceptions">, today: string) {
  if (entry.endsOn >= today) return true;
  const rule = entry.repeat;
  if (!rule) return false;
  if (!rule.until && !rule.count) return true;
  // Bounded by `until` or `count`, so this always ends.
  return expandOccurrences(entry, rule, entry.repeatExceptions ?? [], today, "9999-12-31").length > 0;
}

export function matchesFilters(entry: AdminListEntry, filters: EntryFilters, today: string) {
  if (!matchesSearch(entry, filters.search)) return false;
  if (filters.category === noCategoryFilter) {
    if (entry.category !== "") return false;
  } else if (filters.category && entry.category !== filters.category) return false;
  if (filters.source === staffSourceFilter) {
    if (entry.sourceFeedId !== null) return false;
  } else if (filters.source && entry.sourceFeedId !== filters.source) return false;
  if (filters.entryType && entry.entryType !== filters.entryType) return false;
  if (filters.state === "published" && !entry.isPublished) return false;
  if (filters.state === "draft" && entry.isPublished) return false;
  if (filters.state === "hidden" && !entry.isHiddenLocally) return false;
  if (filters.state === "removed" && !entry.sourceRemovedAt) return false;
  if (filters.time !== "all" && isUpcoming(entry, today) !== (filters.time === "upcoming")) return false;
  return true;
}

const byText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
const byDate = (a: AdminListEntry, b: AdminListEntry) => a.startsOn.localeCompare(b.startsOn) || a.endsOn.localeCompare(b.endsOn);

/** A new array in the given order; ties fall back to date, then title, then id, so the order is stable. */
export function sortEntries<T extends AdminListEntry>(entries: T[], sort: EntrySort): T[] {
  const compare = (a: T, b: T) => {
    if (sort === "title") return byText(a.title, b.title) || byDate(a, b);
    if (sort === "category") {
      if (!a.category !== !b.category) return a.category ? -1 : 1; // no category last
      return byText(a.category, b.category) || byDate(a, b) || byText(a.title, b.title);
    }
    return byDate(a, b) || byText(a.title, b.title);
  };
  return [...entries].sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
}

/** The whole filtered, sorted list: what "Select all N matching" acts on, however much is on screen. */
export function filterAndSortEntries<T extends AdminListEntry>(entries: T[], filters: EntryFilters, sort: EntrySort, today: string): T[] {
  return sortEntries(entries.filter((entry) => matchesFilters(entry, filters, today)), sort);
}

export function selectAllMatching(matching: Array<{ id: string }>) {
  return matching.map((entry) => entry.id);
}

/** The ticked ids that are still in the current matching list, in list order: all a bulk action may touch. */
export function selectedMatchingIds(matching: Array<{ id: string }>, selected: ReadonlySet<string>) {
  return matching.filter((entry) => selected.has(entry.id)).map((entry) => entry.id);
}

export function describeEntryCount(count: number) {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/** "Sorted by date, soonest first". */
export function describeEntrySort(sort: EntrySort) {
  return `Sorted by ${entrySortLabels[sort]}`;
}

// ---- Bulk actions ---------------------------------------------------------

export const maxBulkEntries = 500;

export type BulkAction =
  | { action: "setCategory"; category: string }
  | { action: "publish" }
  | { action: "unpublish" }
  | { action: "hide" }
  | { action: "unhide" };

export type BulkEntryRow = {
  id: string;
  title: string;
  category: string;
  isPublished: boolean;
  isHiddenLocally: boolean;
  sourceFeedId: string | null;
  sourceRemovedAt: Date | string | null;
};

export type BulkChange = {
  id: string;
  title: string;
  data: { category?: string; isPublished?: boolean; isHiddenLocally?: boolean };
};
export type BulkSkip = { id: string; title: string; reason: string };
export type BulkPlan = { changes: BulkChange[]; skipped: BulkSkip[] };

/** The confirm step's question, naming the action and the count. */
export function bulkConfirmMessage(action: BulkAction, count: number) {
  const entries = describeEntryCount(count);
  switch (action.action) {
    case "setCategory": return action.category ? `Set category "${action.category}" on ${entries}?` : `Clear the category on ${entries}?`;
    case "publish": return `Publish ${entries}?`;
    case "unpublish": return `Unpublish ${entries}?`;
    case "hide": return `Hide ${entries} from the public calendar?`;
    case "unhide": return `Unhide ${entries}?`;
  }
}

/**
 * What a bulk action does to each row. A category is not a field a feed
 * imports, so a refresh never overwrites it and nothing is recorded in
 * `locallyEditedFields` (the same as a single edit). Only imported entries can
 * be hidden or unhidden. An entry gone from its feed is not republished: a
 * refresh unpublished it, and if it returns the refresh restores its earlier
 * publish state. Rows already in the wanted state, or that don't qualify, are
 * skipped with a reason.
 */
export function planBulkAction(rows: BulkEntryRow[], request: BulkAction): BulkPlan {
  const plan: BulkPlan = { changes: [], skipped: [] };
  const skip = (row: BulkEntryRow, reason: string) => plan.skipped.push({ id: row.id, title: row.title, reason });
  for (const row of rows) {
    switch (request.action) {
      case "setCategory": {
        if (row.category === request.category) { skip(row, "Already has that category."); break; }
        plan.changes.push({ id: row.id, title: row.title, data: { category: request.category } });
        break;
      }
      case "publish":
        if (row.isPublished) skip(row, "Already published.");
        else if (row.sourceRemovedAt) skip(row, "No longer in its source calendar.");
        else plan.changes.push({ id: row.id, title: row.title, data: { isPublished: true } });
        break;
      case "unpublish":
        if (!row.isPublished) skip(row, "Already unpublished.");
        else plan.changes.push({ id: row.id, title: row.title, data: { isPublished: false } });
        break;
      case "hide":
      case "unhide": {
        const hide = request.action === "hide";
        if (!row.sourceFeedId) skip(row, "Only imported entries can be hidden or unhidden.");
        else if (row.isHiddenLocally === hide) skip(row, hide ? "Already hidden." : "Not hidden.");
        else plan.changes.push({ id: row.id, title: row.title, data: { isHiddenLocally: hide } });
        break;
      }
    }
  }
  return plan;
}

/** "Already published (2); Only imported entries can be hidden or unhidden (1)". */
export function summarizeSkips(skipped: BulkSkip[]) {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${reason.replace(/\.$/, "")} (${count})`).join("; ");
}
