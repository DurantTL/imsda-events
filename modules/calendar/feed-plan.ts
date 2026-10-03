/**
 * What a feed refresh would do to the calendar (#444 part B). Pure: it compares
 * the entries a feed already produced with a freshly parsed feed and returns
 * row-level patches. The preview shows the plan; an import applies it. Nothing
 * is ever deleted: an item that left the feed is unpublished and marked, so
 * anything linked to it (#445) survives and relinks if the item returns.
 */
import { createHash } from "node:crypto";
import { importedFieldNames, type ImportedEntry, type ImportedEntryFields } from "@/modules/calendar/ics-import";

/** A feed entry as stored: the mapped fields plus the bookkeeping the sync reads. */
export type StoredFeedEntry = ImportedEntryFields & {
  id: string;
  sourceUid: string | null;
  sourceRecurrenceId: string | null;
  sourceHash: string | null;
  sourceRemovedAt: Date | null;
  sourceRemovedWasPublished: boolean;
  locallyEditedFields: string[];
  isPublished: boolean;
};

export type FeedDefaults = {
  publishNewItems: boolean;
  defaultCategory: string;
  defaultEntryType: "STANDARD" | "CLOSURE";
};

export type FieldPatch = Partial<ImportedEntryFields> & {
  sourceHash?: string;
  sourceRemovedAt?: Date | null;
  sourceRemovedWasPublished?: boolean;
  isPublished?: boolean;
};

export type FeedPlan = {
  creates: Array<{ entry: ImportedEntry; hash: string; data: ImportedEntryFields & { category: string; entryType: "STANDARD" | "CLOSURE"; isPublished: boolean } }>;
  updates: Array<{ id: string; title: string; kind: "UPDATE" | "REVIVE" | "RELINK"; changedFields: string[]; patch: FieldPatch }>;
  removals: Array<{ id: string; title: string; wasPublished: boolean }>;
  unchanged: number;
};

export function importedFieldsOf(entry: ImportedEntryFields): ImportedEntryFields {
  return Object.fromEntries(importedFieldNames.map((name) => [name, entry[name]])) as ImportedEntryFields;
}

/** A stable fingerprint of the mapped fields, so an unchanged item costs no write. */
export function hashImportedFields(entry: ImportedEntryFields) {
  const fields = importedFieldsOf(entry);
  return createHash("sha256").update(JSON.stringify(importedFieldNames.map((name) => fields[name]))).digest("hex");
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One lock per feed, shared by a refresh and a staff edit of one of its items. */
export const feedLockKey = (feedId: string) => `calendar-feed:${feedId}`;

/**
 * `detached` are items that once came from a feed that was deleted (no feed now).
 * A parsed item with no row in this feed but a detached row with the same
 * (uid, recurrence id) is re-linked to this feed instead of duplicated, so the
 * row keeps its id (and anything linked to it), its edits and its hidden state.
 */
export function planFeedSync(existing: StoredFeedEntry[], parsed: ImportedEntry[], defaults: FeedDefaults, detached: StoredFeedEntry[] = []): FeedPlan {
  const plan: FeedPlan = { creates: [], updates: [], removals: [], unchanged: 0 };
  const byKey = new Map(existing.map((row) => [`${row.sourceUid}\n${row.sourceRecurrenceId ?? ""}`, row]));
  const seen = new Set<string>();
  const detachedByKey = new Map<string, StoredFeedEntry>();
  for (const row of detached) {
    const key = `${row.sourceUid}\n${row.sourceRecurrenceId ?? ""}`;
    if (!detachedByKey.has(key)) detachedByKey.set(key, row);
  }

  for (const entry of parsed) {
    const key = `${entry.uid}\n${entry.recurrenceId}`;
    if (seen.has(key)) continue; // a duplicate within the feed: the first one wins
    seen.add(key);
    const hash = hashImportedFields(entry);
    const own = byKey.get(key);
    const row = own ?? detachedByKey.get(key);
    const relink = !own && row !== undefined;
    if (!row) {
      plan.creates.push({
        entry,
        hash,
        data: { ...importedFieldsOf(entry), category: defaults.defaultCategory, entryType: defaults.defaultEntryType, isPublished: defaults.publishNewItems },
      });
      continue;
    }
    const returning = row.sourceRemovedAt !== null;
    const hashChanged = hash !== row.sourceHash;
    if (!returning && !hashChanged && !relink) {
      plan.unchanged += 1;
      continue;
    }
    const patch: FieldPatch = {};
    const changedFields: string[] = [];
    if (hashChanged) {
      const fresh = importedFieldsOf(entry);
      for (const name of importedFieldNames) {
        if (row.locallyEditedFields.includes(name)) continue; // staff's change wins
        if (!sameValue(row[name], fresh[name])) {
          (patch as Record<string, unknown>)[name] = fresh[name];
          changedFields.push(name);
        }
      }
      patch.sourceHash = hash;
    }
    if (returning) {
      // It comes back as it was before it left: published only if it was.
      patch.sourceRemovedAt = null;
      patch.sourceRemovedWasPublished = false;
      patch.isPublished = row.sourceRemovedWasPublished;
    }
    if (relink) {
      plan.updates.push({ id: row.id, title: entry.title, kind: "RELINK", changedFields, patch });
      continue;
    }
    if (!returning && changedFields.length === 0) {
      // Only the hash moved (every change was one staff made themselves): record it, show nothing.
      plan.updates.push({ id: row.id, title: row.title, kind: "UPDATE", changedFields, patch });
      plan.unchanged += 1;
      continue;
    }
    plan.updates.push({ id: row.id, title: entry.title, kind: returning ? "REVIVE" : "UPDATE", changedFields, patch });
  }

  for (const row of existing) {
    if (row.sourceRemovedAt) continue;
    if (!seen.has(`${row.sourceUid}\n${row.sourceRecurrenceId ?? ""}`)) {
      plan.removals.push({ id: row.id, title: row.title, wasPublished: row.isPublished });
    }
  }
  return plan;
}

/** What the reviewer sees: counts and a row per change. */
export type FeedPreview = {
  counts: { create: number; update: number; revive: number; relink: number; remove: number; unchanged: number };
  rows: Array<{
    action: "CREATE" | "UPDATE" | "REVIVE" | "RELINK" | "REMOVE";
    title: string;
    startsOn: string;
    endsOn: string;
    timeLabel: string;
    repeatRule: string | null;
    changedFields: string[];
  }>;
  warnings: string[];
  totalInFeed: number;
};

export const previewRowLimit = 300;

export function previewOfPlan(plan: FeedPlan, existing: StoredFeedEntry[], parsed: ImportedEntry[], warnings: string[], detached: StoredFeedEntry[] = []): FeedPreview {
  const rows: FeedPreview["rows"] = [];
  for (const created of plan.creates) {
    rows.push({ action: "CREATE", title: created.entry.title, startsOn: created.entry.startsOn, endsOn: created.entry.endsOn, timeLabel: created.entry.timeLabel, repeatRule: created.entry.repeatRule, changedFields: [] });
  }
  const byId = new Map([...detached, ...existing].map((row) => [row.id, row]));
  for (const update of plan.updates) {
    if (update.kind === "UPDATE" && update.changedFields.length === 0) continue;
    const row = byId.get(update.id);
    const patch = update.patch;
    rows.push({
      action: update.kind,
      title: update.title,
      startsOn: patch.startsOn ?? row?.startsOn ?? "",
      endsOn: patch.endsOn ?? row?.endsOn ?? "",
      timeLabel: patch.timeLabel ?? row?.timeLabel ?? "",
      repeatRule: patch.repeatRule === undefined ? (row?.repeatRule ?? null) : patch.repeatRule,
      changedFields: update.changedFields,
    });
  }
  for (const removal of plan.removals) {
    const row = byId.get(removal.id);
    rows.push({ action: "REMOVE", title: removal.title, startsOn: row?.startsOn ?? "", endsOn: row?.endsOn ?? "", timeLabel: row?.timeLabel ?? "", repeatRule: row?.repeatRule ?? null, changedFields: [] });
  }
  const visibleUpdates = plan.updates.filter((update) => update.kind === "REVIVE" || update.kind === "RELINK" || update.changedFields.length > 0);
  return {
    counts: {
      create: plan.creates.length,
      update: visibleUpdates.filter((update) => update.kind === "UPDATE").length,
      revive: visibleUpdates.filter((update) => update.kind === "REVIVE").length,
      relink: visibleUpdates.filter((update) => update.kind === "RELINK").length,
      remove: plan.removals.length,
      unchanged: plan.unchanged,
    },
    rows: rows.slice(0, previewRowLimit),
    warnings,
    totalInFeed: new Set(parsed.map((entry) => `${entry.uid}\n${entry.recurrenceId}`)).size,
  };
}
