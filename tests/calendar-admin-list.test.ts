import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bulkConfirmMessage,
  defaultEntryFilters,
  filterAndSortEntries,
  matchesSearch,
  noCategoryFilter,
  planBulkAction,
  selectAllMatching,
  sortEntries,
  staffSourceFilter,
  summarizeSkips,
  type AdminListEntry,
  type BulkEntryRow,
  type EntryFilters,
} from "@/modules/calendar/admin-list";
import { planFeedSync, type FeedDefaults, type StoredFeedEntry } from "@/modules/calendar/feed-plan";
import { parseIcsFeed } from "@/modules/calendar/ics-import";

const today = "2026-10-05";
let counter = 0;
const entry = (patch: Partial<AdminListEntry> = {}): AdminListEntry => ({
  id: `e-${++counter}`,
  title: "Synthetic gathering",
  description: "",
  location: "",
  category: "",
  startsOn: "2026-11-01",
  endsOn: "2026-11-01",
  entryType: "STANDARD",
  isPublished: true,
  isHiddenLocally: false,
  sourceFeedId: null,
  sourceRemovedAt: null,
  repeat: null,
  ...patch,
});
const filters = (patch: Partial<EntryFilters> = {}): EntryFilters => ({ ...defaultEntryFilters, time: "all", ...patch });
const titles = (list: AdminListEntry[]) => list.map((item) => item.title);

describe("calendar admin search", () => {
  it("matches title, location and description without regard to case", () => {
    const list = [
      entry({ title: "Pathfinder Fair" }),
      entry({ title: "Rally", location: "Camp Synthetic" }),
      entry({ title: "Dinner", description: "Bring a PATHFINDER friend" }),
      entry({ title: "Unrelated" }),
    ];
    expect(titles(filterAndSortEntries(list, filters({ search: "pathfinder" }), "title", today))).toEqual(["Dinner", "Pathfinder Fair"]);
    expect(titles(filterAndSortEntries(list, filters({ search: "  CAMP syn " }), "title", today))).toEqual(["Rally"]);
    expect(matchesSearch(list[3], "")).toBe(true);
    expect(matchesSearch(list[3], "zzz")).toBe(false);
  });
});

describe("calendar admin filters", () => {
  const list = [
    entry({ title: "A", category: "Youth", isPublished: true }),
    entry({ title: "B", category: "", isPublished: false }),
    entry({ title: "C", category: "Youth", sourceFeedId: "feed-1", isHiddenLocally: true }),
    entry({ title: "D", category: "Men", sourceFeedId: "feed-2", sourceRemovedAt: "2026-10-01T00:00:00.000Z", isPublished: false }),
    entry({ title: "E", entryType: "CLOSURE", startsOn: "2026-09-01", endsOn: "2026-09-02" }),
  ];
  const run = (patch: Partial<EntryFilters>) => titles(filterAndSortEntries(list, filters(patch), "title", today));

  it("filters by category, including no category", () => {
    expect(run({ category: "Youth" })).toEqual(["A", "C"]);
    expect(run({ category: noCategoryFilter })).toEqual(["B", "E"]);
  });

  it("filters by source", () => {
    expect(run({ source: staffSourceFilter })).toEqual(["A", "B", "E"]);
    expect(run({ source: "feed-2" })).toEqual(["D"]);
  });

  it("filters by state", () => {
    expect(run({ state: "published" })).toEqual(["A", "C", "E"]);
    expect(run({ state: "draft" })).toEqual(["B", "D"]);
    expect(run({ state: "hidden" })).toEqual(["C"]);
    expect(run({ state: "removed" })).toEqual(["D"]);
  });

  it("filters by time, with upcoming as the default", () => {
    expect(run({ time: "upcoming" })).toEqual(["A", "B", "C", "D"]);
    expect(run({ time: "past" })).toEqual(["E"]);
    expect(defaultEntryFilters.time).toBe("upcoming");
    const repeating = entry({ title: "Weekly", startsOn: "2026-01-01", endsOn: "2026-01-01", repeat: { until: null } });
    const ended = entry({ title: "Ended", startsOn: "2026-01-01", endsOn: "2026-01-01", repeat: { until: "2026-02-01" } });
    expect(titles(filterAndSortEntries([repeating, ended], filters({ time: "upcoming" }), "title", today))).toEqual(["Weekly"]);
  });

  it("filters by entry type and combines filters", () => {
    expect(run({ entryType: "CLOSURE" })).toEqual(["E"]);
    expect(run({ category: "Youth", state: "hidden", source: "feed-1" })).toEqual(["C"]);
    expect(run({ category: "Men", state: "hidden" })).toEqual([]);
  });
});

describe("calendar admin sorting", () => {
  const list = [
    entry({ title: "banana", category: "Youth", startsOn: "2026-12-01", endsOn: "2026-12-01" }),
    entry({ title: "Apple", category: "", startsOn: "2026-11-01", endsOn: "2026-11-01" }),
    entry({ title: "cherry", category: "Men", startsOn: "2026-11-01", endsOn: "2026-11-05" }),
  ];

  it("sorts by date soonest first, then title", () => {
    expect(titles(sortEntries(list, "date"))).toEqual(["Apple", "cherry", "banana"]);
  });

  it("sorts by title ignoring case", () => {
    expect(titles(sortEntries(list, "title"))).toEqual(["Apple", "banana", "cherry"]);
  });

  it("sorts by category with no category last, and does not change the input", () => {
    const before = [...list];
    expect(titles(sortEntries(list, "category"))).toEqual(["cherry", "banana", "Apple"]);
    expect(list).toEqual(before);
  });
});

describe("select all over the filtered set", () => {
  it("covers every matching entry, not only the first page", () => {
    const many = Array.from({ length: 130 }, (_, index) => entry({ title: `Youth ${index}`, category: index % 2 === 0 ? "Youth" : "Men" }));
    const matching = filterAndSortEntries(many, filters({ category: "Youth" }), "date", today);
    const ids = selectAllMatching(matching);
    expect(ids).toHaveLength(65);
    expect(new Set(ids).size).toBe(65);
    expect(ids.every((id) => matching.some((item) => item.id === id && item.category === "Youth"))).toBe(true);
  });
});

describe("bulk action planning", () => {
  const row = (patch: Partial<BulkEntryRow> = {}): BulkEntryRow => ({
    id: `r-${++counter}`,
    title: "Row",
    category: "",
    isPublished: false,
    isHiddenLocally: false,
    sourceFeedId: null,
    sourceUid: null,
    sourceRemovedAt: null,
    locallyEditedFields: [],
    ...patch,
  });

  it("sets a category and records it as a local edit only on imported entries", () => {
    const staff = row({ title: "Staff" });
    const imported = row({ title: "Imported", sourceFeedId: "feed-1", sourceUid: "uid", locallyEditedFields: ["title"] });
    const same = row({ title: "Same", category: "Youth" });
    const plan = planBulkAction([staff, imported, same], { action: "setCategory", category: "Youth" });
    expect(plan.changes.map((change) => [change.title, change.data])).toEqual([
      ["Staff", { category: "Youth" }],
      ["Imported", { category: "Youth", locallyEditedFields: ["title", "category"] }],
    ]);
    expect(plan.skipped).toEqual([{ id: same.id, title: "Same", reason: "Already has that category." }]);
  });

  it("clears a category", () => {
    const plan = planBulkAction([row({ category: "Youth" })], { action: "setCategory", category: "" });
    expect(plan.changes[0].data.category).toBe("");
  });

  it("publishes and unpublishes, skipping what is already so or gone from its feed", () => {
    const draft = row({ title: "Draft" });
    const live = row({ title: "Live", isPublished: true });
    const gone = row({ title: "Gone", sourceFeedId: "f", sourceRemovedAt: new Date() });
    const publish = planBulkAction([draft, live, gone], { action: "publish" });
    expect(publish.changes.map((change) => change.title)).toEqual(["Draft"]);
    expect(publish.skipped.map((item) => item.reason)).toEqual(["Already published.", "No longer in its source calendar."]);
    const unpublish = planBulkAction([draft, live], { action: "unpublish" });
    expect(unpublish.changes.map((change) => change.title)).toEqual(["Live"]);
    expect(unpublish.skipped[0].reason).toBe("Already unpublished.");
  });

  it("hides and unhides imported entries only", () => {
    const staff = row({ title: "Staff" });
    const imported = row({ title: "Imported", sourceFeedId: "f" });
    const hidden = row({ title: "Hidden", sourceFeedId: "f", isHiddenLocally: true });
    const hide = planBulkAction([staff, imported, hidden], { action: "hide" });
    expect(hide.changes.map((change) => [change.title, change.data])).toEqual([["Imported", { isHiddenLocally: true }]]);
    expect(hide.skipped.map((item) => item.reason)).toEqual(["Only imported entries can be hidden or unhidden.", "Already hidden."]);
    const unhide = planBulkAction([staff, imported, hidden], { action: "unhide" });
    expect(unhide.changes.map((change) => change.title)).toEqual(["Hidden"]);
  });

  it("words the confirm step and the skipped summary", () => {
    expect(bulkConfirmMessage({ action: "setCategory", category: "Youth" }, 37)).toBe('Set category "Youth" on 37 entries?');
    expect(bulkConfirmMessage({ action: "setCategory", category: "" }, 1)).toBe("Clear the category on 1 entry?");
    expect(bulkConfirmMessage({ action: "publish" }, 2)).toBe("Publish 2 entries?");
    expect(summarizeSkips([
      { id: "1", title: "a", reason: "Already published." },
      { id: "2", title: "b", reason: "Already published." },
      { id: "3", title: "c", reason: "Not hidden." },
    ])).toBe("Already published (2); Not hidden (1)");
  });
});

describe("a feed refresh after a bulk category change", () => {
  const fixture = readFileSync(new URL("./fixtures/calendar-feed.ics", import.meta.url), "utf8");
  const parsed = parseIcsFeed(fixture).entries;
  const defaults: FeedDefaults = { publishNewItems: false, defaultCategory: "Conference", defaultEntryType: "STANDARD" };

  it("keeps the category staff set", () => {
    const first = planFeedSync([], parsed, defaults).creates[0];
    const stored: StoredFeedEntry & { category: string } = {
      ...first.data,
      id: "row-1",
      sourceUid: first.entry.uid,
      sourceRecurrenceId: first.entry.recurrenceId,
      sourceHash: first.hash,
      sourceRemovedAt: null,
      sourceRemovedWasPublished: false,
      locallyEditedFields: [],
      category: "Conference",
    };
    const bulk = planBulkAction([{ ...stored, sourceFeedId: "feed-1", isHiddenLocally: false }], { action: "setCategory", category: "Youth" });
    Object.assign(stored, bulk.changes[0].data);
    expect(stored.category).toBe("Youth");
    expect(stored.locallyEditedFields).toContain("category");

    const renamed = parsed.map((item) => (item.uid === first.entry.uid ? { ...item, title: "Renamed in Google" } : item));
    const plan = planFeedSync([stored], renamed.filter((item) => item.uid === first.entry.uid), defaults);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].patch).toMatchObject({ title: "Renamed in Google" });
    expect(plan.updates[0].patch).not.toHaveProperty("category");
    Object.assign(stored, plan.updates[0].patch);
    expect(stored.category).toBe("Youth");
  });
});
