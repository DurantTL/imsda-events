import "server-only";

import { Prisma } from "@prisma/client";
import { logError } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";
import { fingerprintSecret, isSecretEncryptionConfigured, openSecret, SecretBoxError, sealSecret } from "@/lib/secret-box";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { FeedFetchError, feedUrlHint, fetchFeedText, normalizeFeedUrl, type FeedTransport, type HostResolver } from "@/modules/calendar/feed-fetch";
import { feedLockKey, planFeedSync, previewOfPlan, type FeedPlan, type FeedPreview, type StoredFeedEntry } from "@/modules/calendar/feed-plan";
import { IcsParseError, parseIcsFeed, type ParsedIcsFeed } from "@/modules/calendar/ics-import";
import { CalendarError, listCalendarEntries } from "@/modules/calendar/repository";
import type { CalendarFeedInput, CalendarFeedUpdate } from "@/modules/calendar/schemas";

/** The purpose string the feed address is sealed under; a value can't be moved to another column. */
export const feedSecretPurpose = "calendar-feed-url";

/** How many due feeds one 5-minute sweep refreshes. */
export const feedsPerSweep = 3;

type Deps = { transport?: FeedTransport; resolve?: HostResolver };

export type CalendarAdminFeed = Awaited<ReturnType<typeof listCalendarFeeds>>[number];

/** Feeds for the admin page. The sealed address is never selected, so it can't reach a response. */
export async function listCalendarFeeds() {
  const feeds = await getPrisma().calendarFeed.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, urlHint: true, defaultCategory: true, defaultEntryType: true, publishNewItems: true,
      isEnabled: true, refreshMinutes: true, lastFetchedAt: true, lastSucceededAt: true, lastStatus: true,
      lastError: true, lastItemCount: true, _count: { select: { entries: true } },
    },
  });
  return feeds.map((feed) => ({
    id: feed.id,
    name: feed.name,
    urlHint: feed.urlHint,
    defaultCategory: feed.defaultCategory,
    defaultEntryType: feed.defaultEntryType,
    publishNewItems: feed.publishNewItems,
    isEnabled: feed.isEnabled,
    refreshMinutes: feed.refreshMinutes,
    lastFetchedAt: feed.lastFetchedAt?.toISOString() ?? null,
    lastSucceededAt: feed.lastSucceededAt?.toISOString() ?? null,
    lastStatus: feed.lastStatus,
    lastError: feed.lastError,
    lastItemCount: feed.lastItemCount,
    entryCount: feed._count.entries,
    imported: feed.lastSucceededAt !== null,
  }));
}

/** The same calendar can't be connected twice: look the keyed fingerprint of the normalized address up, opening no sealed address. */
async function assertNotConnected(fingerprint: string, exceptFeedId?: string) {
  const others = await getPrisma().calendarFeed.findMany({ where: { urlFingerprint: fingerprint }, select: { id: true, name: true } });
  const other = others.find((candidate) => candidate.id !== exceptFeedId);
  if (other) throw new CalendarError("INVALID_FEED", alreadyConnected(other.name));
}

const alreadyConnected = (name: string) => `This calendar is already connected as ${name}.`;

/** Two saves racing past the check above meet the unique constraint; answer them the same friendly way. */
async function mapDuplicate(error: unknown, fingerprint: string, exceptFeedId?: string): Promise<never> {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const others = await getPrisma().calendarFeed.findMany({ where: { urlFingerprint: fingerprint }, select: { id: true, name: true } });
    const other = others.find((candidate) => candidate.id !== exceptFeedId);
    if (other) throw new CalendarError("INVALID_FEED", alreadyConnected(other.name));
  }
  throw error;
}

async function sealedAddress(rawUrl: string, exceptFeedId?: string) {
  let url: URL;
  try {
    url = normalizeFeedUrl(rawUrl);
  } catch (error) {
    if (error instanceof FeedFetchError) throw new CalendarError("INVALID_FEED", error.message);
    throw error;
  }
  if (!isSecretEncryptionConfigured()) {
    throw new CalendarError("FEED_SECRET_MISSING", "Saving calendar addresses needs the encryption key (SECRET_ENCRYPTION_KEY) to be set on the server.");
  }
  const urlFingerprint = fingerprintSecret(url.toString(), feedSecretPurpose);
  await assertNotConnected(urlFingerprint, exceptFeedId);
  return { sealedUrl: sealSecret(url.toString(), feedSecretPurpose), urlHint: feedUrlHint(url), urlFingerprint };
}

export async function createCalendarFeed(input: CalendarFeedInput, actorUserId: string) {
  const { url, ...fields } = input;
  const address = await sealedAddress(url);
  await getPrisma().$transaction(async (tx) => {
    const feed = await tx.calendarFeed.create({ data: { ...fields, ...address, createdByUserId: actorUserId, updatedByUserId: actorUserId } });
    await writeAuditLog({
      actorUserId,
      action: "CALENDAR_FEED_CREATED",
      entityType: "CalendarFeed",
      entityId: feed.id,
      summary: `Added the imported calendar "${feed.name}".`,
      metadata: { name: feed.name, urlHint: feed.urlHint },
    }, tx);
  }).catch((error: unknown) => mapDuplicate(error, address.urlFingerprint));
  return listCalendarFeeds();
}

export async function updateCalendarFeed(feedId: string, input: CalendarFeedUpdate, actorUserId: string) {
  const { url, ...fields } = input;
  // A blank address on an edit keeps the saved one.
  const address = url ? await sealedAddress(url, feedId) : null;
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.calendarFeed.findUnique({ where: { id: feedId }, select: { id: true } });
    if (!existing) throw new CalendarError("FEED_NOT_FOUND", "That imported calendar could not be found.");
    const feed = await tx.calendarFeed.update({ where: { id: feedId }, data: { ...fields, ...(address ?? {}), updatedByUserId: actorUserId } });
    await writeAuditLog({
      actorUserId,
      action: "CALENDAR_FEED_UPDATED",
      entityType: "CalendarFeed",
      entityId: feed.id,
      summary: `Updated the imported calendar "${feed.name}".`,
      metadata: { changed: Object.keys({ ...fields, ...(url ? { url: true } : {}) }) },
    }, tx);
  }).catch((error: unknown) => (address ? mapDuplicate(error, address.urlFingerprint, feedId) : Promise.reject(error)));
  return listCalendarFeeds();
}

/**
 * Removes the feed and keeps what it imported: the entries become ordinary
 * staff-made items. Any that were hidden or had left the feed are unpublished
 * drafts, so deleting a feed never makes something appear.
 */
export async function deleteCalendarFeed(feedId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.calendarFeed.findUnique({ where: { id: feedId }, select: { id: true, name: true, urlFingerprint: true } });
    if (!existing) throw new CalendarError("FEED_NOT_FOUND", "That imported calendar could not be found.");
    // Remember which calendar these came from, so only the same calendar can re-link them.
    await tx.calendarEntry.updateMany({ where: { sourceFeedId: feedId }, data: { sourceUrlFingerprint: existing.urlFingerprint } });
    await tx.calendarEntry.updateMany({
      where: { sourceFeedId: feedId, OR: [{ isHiddenLocally: true }, { sourceRemovedAt: { not: null } }] },
      data: { isPublished: false, isHiddenLocally: false, sourceRemovedAt: null },
    });
    await tx.calendarFeed.delete({ where: { id: feedId } });
    await writeAuditLog({
      actorUserId,
      action: "CALENDAR_FEED_DELETED",
      entityType: "CalendarFeed",
      entityId: feedId,
      summary: `Removed the imported calendar "${existing.name}". Its items stay on the calendar.`,
    }, tx);
  });
  return listCalendarFeeds();
}

/** The message staff see for any failure; it never contains the address. */
function failureMessage(error: unknown) {
  if (error instanceof FeedFetchError || error instanceof IcsParseError) return error.message;
  if (error instanceof SecretBoxError) return "The saved address could not be read. Edit the calendar and enter its address again.";
  logError("A calendar feed could not be read", error);
  return "The feed could not be imported.";
}

async function loadAndParse(feed: { sealedUrl: string }, deps: Deps): Promise<ParsedIcsFeed> {
  const text = await fetchFeedText(openSecret(feed.sealedUrl, feedSecretPurpose), deps);
  return parseIcsFeed(text);
}

const storedSelect = {
  id: true, title: true, description: true, location: true, linkUrl: true, status: true, startsOn: true, endsOn: true,
  timeLabel: true, repeatRule: true, repeatExceptions: true, sourceUid: true, sourceRecurrenceId: true, sourceHash: true,
  sourceRemovedAt: true, sourceRemovedWasPublished: true, locallyEditedFields: true, isPublished: true,
} as const;

type StoredRow = Prisma.CalendarEntryGetPayload<{ select: typeof storedSelect }>;

function toStored(row: StoredRow): StoredFeedEntry {
  return { ...row, status: row.status === "CANCELLED" ? "CANCELLED" : "SCHEDULED", repeatExceptions: row.repeatExceptions ?? [] };
}

async function findFeed(feedId: string) {
  const feed = await getPrisma().calendarFeed.findUnique({ where: { id: feedId } });
  if (!feed) throw new CalendarError("FEED_NOT_FOUND", "That imported calendar could not be found.");
  return feed;
}

/** Items left behind by a deleted feed that this feed's items would re-link to rather than duplicate. */
async function loadDetached(client: { calendarEntry: Pick<ReturnType<typeof getPrisma>["calendarEntry"], "findMany"> }, parsed: ParsedIcsFeed, urlFingerprint: string) {
  const uids = [...new Set(parsed.entries.map((entry) => entry.uid))];
  if (uids.length === 0) return [];
  const rows = await client.calendarEntry.findMany({
    // Only items that came from a feed with this very address, never another calendar's.
    where: { sourceFeedId: null, sourceUrlFingerprint: urlFingerprint, sourceUid: { in: uids } },
    select: storedSelect,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toStored);
}

const emptyMessage = "The calendar came back empty; nothing was changed.";

/** What an import would do, with nothing written. */
export async function previewCalendarFeed(feedId: string, deps: Deps = {}): Promise<FeedPreview> {
  const feed = await findFeed(feedId);
  let parsed: ParsedIcsFeed;
  try {
    parsed = await loadAndParse(feed, deps);
  } catch (error) {
    throw new CalendarError("FEED_FETCH_FAILED", failureMessage(error));
  }
  const rows = await getPrisma().calendarEntry.findMany({ where: { sourceFeedId: feedId }, select: storedSelect });
  const existing = rows.map(toStored);
  const detached = await loadDetached(getPrisma(), parsed, feed.urlFingerprint);
  const warnings = [...parsed.warnings];
  const active = existing.filter((row) => !row.sourceRemovedAt).length;
  if (parsed.entries.length === 0 && active > 0) {
    warnings.unshift(`The calendar came back empty. Applying this would remove all ${active} imported items from the public calendar; automatic refreshes refuse to do that.`);
  }
  return previewOfPlan(planFeedSync(existing, parsed.entries, feed, detached), existing, parsed.entries, warnings, detached);
}

export type FeedSyncSummary = FeedPreview["counts"] & { warnings: string[]; totalInFeed: number };

async function recordFailure(feedId: string, message: string, now: Date) {
  await getPrisma().calendarFeed.update({
    where: { id: feedId },
    data: { lastFetchedAt: now, lastStatus: "FAILED", lastError: message.slice(0, 300) },
  }).catch((error) => logError("Could not record a calendar feed failure", error));
}

/**
 * Fetches the feed and applies it, in one transaction per feed. A failure
 * leaves every entry exactly as it was and is recorded on the feed only.
 * Safe to run twice: an unchanged item writes nothing.
 */
export async function syncCalendarFeed(
  feedId: string,
  options: { actorUserId?: string; now?: Date; allowEmpty?: boolean } & Deps = {},
): Promise<FeedSyncSummary> {
  const now = options.now ?? new Date();
  const feed = await findFeed(feedId);
  let parsed: ParsedIcsFeed;
  try {
    parsed = await loadAndParse(feed, options);
  } catch (error) {
    const message = failureMessage(error);
    await recordFailure(feedId, message, now);
    throw new CalendarError("FEED_FETCH_FAILED", message);
  }

  const itemCount = new Set(parsed.entries.map((entry) => `${entry.uid}\n${entry.recurrenceId}`)).size;
  let plan: FeedPlan;
  try {
    plan = await getPrisma().$transaction(async (tx) => {
      // One sync of a feed at a time; a manual refresh and the sweep can overlap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${feedLockKey(feedId)}))`;
      const rows = await tx.calendarEntry.findMany({ where: { sourceFeedId: feedId }, select: storedSelect });
      const stored = rows.map(toStored);
      // A feed that suddenly has nothing is far more often a fault than an emptied calendar: don't unpublish everything.
      if (parsed.entries.length === 0 && !options.allowEmpty && stored.some((row) => !row.sourceRemovedAt)) {
        throw new FeedFetchError(emptyMessage);
      }
      const detached = await loadDetached(tx, parsed, feed.urlFingerprint);
      const planned = planFeedSync(stored, parsed.entries, feed, detached);
      const actor = options.actorUserId ?? feed.updatedByUserId;

      if (planned.creates.length > 0) {
        await tx.calendarEntry.createMany({
          data: planned.creates.map(({ entry, hash, data }) => ({
            ...data,
            sourceFeedId: feedId,
            sourceUid: entry.uid,
            sourceRecurrenceId: entry.recurrenceId,
            sourceHash: hash,
            createdByUserId: actor,
            updatedByUserId: actor,
          })),
        });
      }
      for (const update of planned.updates) {
        await tx.calendarEntry.update({
          where: { id: update.id },
          data: { ...update.patch, ...(update.kind === "RELINK" ? { sourceFeedId: feedId } : {}), updatedByUserId: actor },
        });
      }
      for (const wasPublished of [true, false]) {
        const ids = planned.removals.filter((removal) => removal.wasPublished === wasPublished).map((removal) => removal.id);
        if (ids.length > 0) {
          await tx.calendarEntry.updateMany({
            where: { id: { in: ids } },
            data: { sourceRemovedAt: now, sourceRemovedWasPublished: wasPublished, isPublished: false, updatedByUserId: actor },
          });
        }
      }
      await tx.calendarFeed.update({
        where: { id: feedId },
        data: { lastFetchedAt: now, lastSucceededAt: now, lastStatus: "OK", lastError: null, lastItemCount: itemCount },
      });
      const changed = planned.creates.length + planned.updates.length + planned.removals.length;
      if (changed > 0 || options.actorUserId) {
        await writeAuditLog({
          actorUserId: options.actorUserId,
          action: "CALENDAR_FEED_SYNCED",
          entityType: "CalendarFeed",
          entityId: feedId,
          summary: `Refreshed the imported calendar "${feed.name}".`,
          metadata: { created: planned.creates.length, updated: planned.updates.length, removed: planned.removals.length, warnings: parsed.warnings.length },
        }, tx);
      }
      return planned;
    }, { timeout: 60_000, maxWait: 10_000 });
  } catch (error) {
    const message = failureMessage(error);
    await recordFailure(feedId, message, now);
    throw new CalendarError("FEED_FETCH_FAILED", message);
  }

  const visibleUpdates = plan.updates.filter((update) => update.kind === "REVIVE" || update.kind === "RELINK" || update.changedFields.length > 0);
  return {
    create: plan.creates.length,
    update: visibleUpdates.filter((update) => update.kind === "UPDATE").length,
    revive: visibleUpdates.filter((update) => update.kind === "REVIVE").length,
    relink: visibleUpdates.filter((update) => update.kind === "RELINK").length,
    remove: plan.removals.length,
    unchanged: plan.unchanged,
    warnings: parsed.warnings,
    totalInFeed: itemCount,
  };
}

/**
 * Called by the five-minute sweep: refreshes enabled feeds that have been
 * imported once and whose last fetch is older than their own cadence, a few at
 * a time. One feed failing never stops the others.
 */
export async function refreshDueCalendarFeeds(now = new Date(), deps: Deps = {}) {
  const candidates = await getPrisma().calendarFeed.findMany({
    where: { isEnabled: true, lastSucceededAt: { not: null } },
    orderBy: [{ lastFetchedAt: { sort: "asc", nulls: "first" } }],
    take: 50,
    select: { id: true, refreshMinutes: true, lastFetchedAt: true },
  });
  const due = candidates
    .filter((feed) => !feed.lastFetchedAt || now.getTime() - feed.lastFetchedAt.getTime() >= feed.refreshMinutes * 60_000)
    .slice(0, feedsPerSweep);
  let refreshed = 0;
  let failed = 0;
  for (const feed of due) {
    try {
      await syncCalendarFeed(feed.id, { now, ...deps });
      refreshed += 1;
    } catch {
      failed += 1; // already recorded on the feed, without its address
    }
  }
  return { due: due.length, refreshed, failed };
}

/** Hide or show an imported item on the public calendar without touching the source or its other settings. */
export async function setCalendarEntryHidden(entryId: string, hidden: boolean, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.calendarEntry.findUnique({ where: { id: entryId }, select: { id: true, title: true, sourceFeedId: true } });
    if (!existing) throw new CalendarError("ENTRY_NOT_FOUND", "That calendar entry could not be found.");
    if (!existing.sourceFeedId) throw new CalendarError("NOT_IMPORTED", "Only imported items can be hidden this way.");
    await tx.calendarEntry.update({ where: { id: entryId }, data: { isHiddenLocally: hidden, updatedByUserId: actorUserId } });
    await writeAuditLog({
      actorUserId,
      action: hidden ? "CALENDAR_ENTRY_HIDDEN" : "CALENDAR_ENTRY_SHOWN",
      entityType: "CalendarEntry",
      entityId: entryId,
      summary: `${hidden ? "Hid" : "Showed"} the imported item "${existing.title}" on the calendar.`,
    }, tx);
  });
  return listCalendarEntries();
}

/**
 * "Reset to Google's version": forgets the staff edits and re-reads the feed.
 * If the feed can't be reached right now the reset still stands and applies on
 * the next refresh.
 */
export async function resetCalendarEntryToSource(entryId: string, actorUserId: string, deps: Deps = {}) {
  const existing = await getPrisma().calendarEntry.findUnique({ where: { id: entryId }, select: { id: true, title: true, sourceFeedId: true } });
  if (!existing) throw new CalendarError("ENTRY_NOT_FOUND", "That calendar entry could not be found.");
  if (!existing.sourceFeedId) throw new CalendarError("NOT_IMPORTED", "Only imported items can be reset.");
  await getPrisma().$transaction(async (tx) => {
    await tx.calendarEntry.update({
      where: { id: entryId },
      data: { locallyEditedFields: [], sourceHash: null, updatedByUserId: actorUserId },
    });
    await writeAuditLog({
      actorUserId,
      action: "CALENDAR_ENTRY_RESET_TO_SOURCE",
      entityType: "CalendarEntry",
      entityId: entryId,
      summary: `Reset the imported item "${existing.title}" to its source version.`,
    }, tx);
  });
  let applied = true;
  try {
    await syncCalendarFeed(existing.sourceFeedId, { actorUserId, ...deps });
  } catch {
    applied = false;
  }
  return { entries: await listCalendarEntries(), applied };
}
