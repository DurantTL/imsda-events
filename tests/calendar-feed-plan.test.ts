import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashImportedFields, planFeedSync, previewOfPlan, type FeedDefaults, type StoredFeedEntry } from "@/modules/calendar/feed-plan";
import { importedFieldNames, parseIcsFeed, type ImportedEntry } from "@/modules/calendar/ics-import";

const fixture = readFileSync(new URL("./fixtures/calendar-feed.ics", import.meta.url), "utf8");
const defaults: FeedDefaults = { publishNewItems: false, defaultCategory: "Conference", defaultEntryType: "STANDARD" };
const now = new Date("2026-10-03T12:00:00Z");

/** A tiny in-memory stand-in for the feed's entries, applying a plan the way the service does. */
function apply(rows: StoredFeedEntry[], parsed: ImportedEntry[], feed = defaults) {
  const plan = planFeedSync(rows, parsed, feed);
  let writes = 0;
  const next = rows.map((row) => ({ ...row }));
  for (const created of plan.creates) {
    writes += 1;
    next.push({
      ...created.data, id: `row-${next.length}`, sourceUid: created.entry.uid, sourceRecurrenceId: created.entry.recurrenceId,
      sourceHash: created.hash, sourceRemovedAt: null, sourceRemovedWasPublished: false, locallyEditedFields: [],
    });
  }
  for (const update of plan.updates) {
    writes += 1;
    Object.assign(next.find((row) => row.id === update.id)!, update.patch);
  }
  for (const removal of plan.removals) {
    writes += 1;
    Object.assign(next.find((row) => row.id === removal.id)!, { sourceRemovedAt: now, sourceRemovedWasPublished: removal.wasPublished, isPublished: false });
  }
  return { rows: next, plan, writes };
}

const parsed = parseIcsFeed(fixture).entries;
const first = (rows: StoredFeedEntry[], uid: string, recurrenceId = "") => rows.find((row) => row.sourceUid === uid && row.sourceRecurrenceId === recurrenceId)!;

describe("feed sync plan", () => {
  it("creates every item once, as drafts, with the feed's defaults", () => {
    const { rows, plan } = apply([], parsed);
    expect(plan.creates).toHaveLength(parsed.length);
    expect(rows.every((row) => !row.isPublished)).toBe(true);
    expect(plan.creates[0].data).toMatchObject({ category: "Conference", entryType: "STANDARD" });
  });

  it("publishes new items when the feed says to", () => {
    const { rows } = apply([], parsed, { ...defaults, publishNewItems: true, defaultEntryType: "CLOSURE" });
    expect(rows.every((row) => row.isPublished)).toBe(true);
  });

  it("is idempotent: a second run writes nothing", () => {
    const once = apply([], parsed);
    const twice = apply(once.rows, parsed);
    expect(twice.writes).toBe(0);
    expect(twice.plan.unchanged).toBe(parsed.length);
  });

  it("updates only what changed in the feed", () => {
    const once = apply([], parsed);
    const changed = parsed.map((entry) => (entry.uid === "allday-1@synthetic.test" ? { ...entry, title: "Renamed Camporee", location: "New place" } : entry));
    const twice = apply(once.rows, changed);
    expect(twice.writes).toBe(1);
    expect(first(twice.rows, "allday-1@synthetic.test")).toMatchObject({ title: "Renamed Camporee", location: "New place", sourceHash: hashImportedFields(changed.find((entry) => entry.uid === "allday-1@synthetic.test")!) });
    expect(twice.plan.updates[0].changedFields).toEqual(["title", "location"]);
  });

  it("keeps a staff edit across a refresh, but still updates the other fields", () => {
    const once = apply([], parsed);
    const edited = once.rows.map((row) => (row.sourceUid === "allday-1@synthetic.test"
      ? { ...row, title: "Our own title", locallyEditedFields: ["title"] } : row));
    const changed = parsed.map((entry) => (entry.uid === "allday-1@synthetic.test" ? { ...entry, title: "Google renamed it", location: "Camp Synthetic" } : entry));
    const twice = apply(edited, changed);
    expect(first(twice.rows, "allday-1@synthetic.test")).toMatchObject({ title: "Our own title", location: "Camp Synthetic" });
    // And once settled, nothing more is written.
    expect(apply(twice.rows, changed).writes).toBe(0);
  });

  it("records a hash only when every change was one staff made", () => {
    const once = apply([], parsed);
    const edited = once.rows.map((row) => (row.sourceUid === "allday-1@synthetic.test" ? { ...row, title: "Mine", locallyEditedFields: ["title"] } : row));
    const changed = parsed.map((entry) => (entry.uid === "allday-1@synthetic.test" ? { ...entry, title: "Theirs" } : entry));
    const twice = apply(edited, changed);
    expect(twice.plan.updates[0].changedFields).toEqual([]);
    const preview = previewOfPlan(twice.plan, edited, changed, []);
    expect(preview.rows).toHaveLength(0);
    expect(preview.counts.update).toBe(0);
    expect(apply(twice.rows, changed).writes).toBe(0);
  });

  it("restores the source's version after a reset (edits cleared, hash forgotten)", () => {
    const once = apply([], parsed);
    const reset = once.rows.map((row) => (row.sourceUid === "allday-1@synthetic.test"
      ? { ...row, title: "Our own title", locallyEditedFields: [], sourceHash: null } : row));
    const twice = apply(reset, parsed);
    expect(first(twice.rows, "allday-1@synthetic.test").title).toBe("Synthetic Camporee");
  });

  it("never touches publication, category or type of an existing item", () => {
    const once = apply([], parsed, { ...defaults, publishNewItems: true });
    const changed = parsed.map((entry) => ({ ...entry, title: `${entry.title}!` }));
    const twice = apply(once.rows, changed, { ...defaults, publishNewItems: false, defaultCategory: "Other" });
    expect(twice.rows.every((row) => row.isPublished)).toBe(true);
    for (const patch of twice.plan.updates.map((update) => update.patch)) {
      expect(Object.keys(patch).every((key) => (importedFieldNames as readonly string[]).includes(key) || key === "sourceHash")).toBe(true);
    }
  });

  it("unpublishes, never deletes, what left the feed, and does it only once", () => {
    const published = apply([], parsed, { ...defaults, publishNewItems: true });
    const remaining = parsed.filter((entry) => entry.uid !== "allday-1@synthetic.test");
    const gone = apply(published.rows, remaining);
    expect(gone.rows).toHaveLength(published.rows.length);
    expect(first(gone.rows, "allday-1@synthetic.test")).toMatchObject({ isPublished: false, sourceRemovedWasPublished: true });
    expect(first(gone.rows, "allday-1@synthetic.test").sourceRemovedAt).not.toBeNull();
    expect(apply(gone.rows, remaining).writes).toBe(0);
  });

  it("brings an item back as it was: republished only if it was published before it left", () => {
    const rows = apply([], parsed, { ...defaults, publishNewItems: true }).rows;
    // One was a draft before removal.
    rows.find((row) => row.sourceUid === "cancelled-1@synthetic.test")!.isPublished = false;
    const remaining = parsed.filter((entry) => !["allday-1@synthetic.test", "cancelled-1@synthetic.test"].includes(entry.uid));
    const gone = apply(rows, remaining);
    const back = apply(gone.rows, parsed);
    expect(first(back.rows, "allday-1@synthetic.test")).toMatchObject({ isPublished: true, sourceRemovedAt: null, sourceRemovedWasPublished: false });
    expect(first(back.rows, "cancelled-1@synthetic.test")).toMatchObject({ isPublished: false, sourceRemovedAt: null });
    expect(back.rows).toHaveLength(rows.length); // the same rows: links to them survive
    expect(back.plan.updates.every((update) => update.kind === "REVIVE")).toBe(true);
    expect(apply(back.rows, parsed).writes).toBe(0);
  });

  it("handles duplicate UIDs within a feed by keeping the first", () => {
    const duplicate: ImportedEntry = { ...parsed[0], title: "Second copy" };
    const { rows, plan } = apply([], [...parsed, duplicate]);
    expect(plan.creates).toHaveLength(parsed.length);
    expect(first(rows, parsed[0].uid, parsed[0].recurrenceId).title).toBe(parsed[0].title);
  });

  it("previews creates, updates and removals without writing", () => {
    const once = apply([], parsed, { ...defaults, publishNewItems: true });
    const next = parsed
      .filter((entry) => entry.uid !== "cancelled-1@synthetic.test")
      .map((entry) => (entry.uid === "allday-1@synthetic.test" ? { ...entry, endsOn: "2026-10-12" } : entry))
      .concat([{ ...parsed[0], uid: "brand-new", title: "Brand new" }]);
    const preview = previewOfPlan(planFeedSync(once.rows, next, defaults), once.rows, next, ["a warning"]);
    expect(preview.counts).toMatchObject({ create: 1, update: 1, remove: 1 });
    expect(preview.rows.map((row) => row.action).sort()).toEqual(["CREATE", "REMOVE", "UPDATE"]);
    expect(preview.rows.find((row) => row.action === "UPDATE")?.changedFields).toEqual(["endsOn"]);
    expect(preview.warnings).toEqual(["a warning"]);
  });
});
