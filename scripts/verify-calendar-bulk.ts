/**
 * Proves the calendar admin's bulk change (#796) against a real PostgreSQL
 * database, with fictitious entries it creates and removes itself:
 *
 * - the feed's advisory lock is taken: while another transaction holds it, a
 *   bulk change on that feed's entries waits, then runs when it is released;
 * - the rows are read again under the lock: a change committed while the bulk
 *   change waited is seen (an entry published meanwhile is "Already published");
 * - a feed sync racing a bulk change never leaves an entry both removed from its
 *   feed and published, and a bulk hide survives the sync;
 * - the 500-entry cap: 500 are changed in one request, 501 are refused;
 * - a refresh keeps a bulk-set category, with no `locallyEditedFields` mark;
 * - one summary audit row lists the changed ids.
 *
 *   npm run test:calendar-bulk
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
// A synthetic key for this run's own sealed feed address, when none is configured.
process.env.SECRET_ENCRYPTION_KEY ||= "verify-calendar-bulk-synthetic-key-not-a-secret";

const prisma = new PrismaClient();
const P = "cbulk";
const userId = `${P}_admin`;
const feedUrl = "https://calendar.example.test/ical/cbulk-synthetic/basic.ics";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const ics = (events: Array<{ uid: string; title: string; day: string }>) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Synthetic//Calendar Bulk//EN",
  ...events.flatMap(({ uid, title, day }) => [
    "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T000000Z", `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${day}`, `SUMMARY:${title}`, "END:VEVENT",
  ]),
  "END:VCALENDAR",
].join("\r\n");

const resolve = async () => ["93.184.216.34"];
let feedBody = "";
const transport = async () => ({ status: 200, location: null, body: feedBody });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function cleanup() {
  await prisma.calendarEntry.deleteMany({ where: { createdByUserId: userId } });
  await prisma.calendarFeed.deleteMany({ where: { createdByUserId: userId } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function main() {
  const { createCalendarFeed, syncCalendarFeed } = await import("@/modules/calendar/feeds");
  const { bulkUpdateCalendarEntries } = await import("@/modules/calendar/repository");
  const { calendarBulkSchema } = await import("@/modules/calendar/schemas");
  const { feedLockKey } = await import("@/modules/calendar/feed-plan");

  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}-admin@example.test`, displayName: "Calendar Bulk Check", globalRole: "SYSTEM_ADMIN" } });

  const bulk = (ids: string[], change: Parameters<typeof calendarBulkSchema.parse>[0]["change"]) =>
    bulkUpdateCalendarEntries(calendarBulkSchema.parse({ ids, change }), userId);

  // A feed with three imported entries, and two staff-made ones.
  feedBody = ics([
    { uid: "a@cbulk.test", title: "Imported A", day: "20261110" },
    { uid: "b@cbulk.test", title: "Imported B", day: "20261111" },
    { uid: "c@cbulk.test", title: "Imported C", day: "20261112" },
  ]);
  await createCalendarFeed({ name: "Calendar bulk check feed", url: feedUrl, defaultCategory: "Conference", defaultEntryType: "STANDARD", publishNewItems: false, isEnabled: true, refreshMinutes: 60 }, userId);
  const feed = await prisma.calendarFeed.findFirstOrThrow({ where: { createdByUserId: userId } });
  await syncCalendarFeed(feed.id, { actorUserId: userId, transport, resolve });
  const imported = await prisma.calendarEntry.findMany({ where: { sourceFeedId: feed.id }, orderBy: { title: "asc" } });
  assert(imported.length === 3, `the feed imported 3 entries (got ${imported.length})`);
  const [a, b, c] = imported;
  const staff = await Promise.all(["Staff 1", "Staff 2"].map((title) => prisma.calendarEntry.create({
    data: { title, startsOn: "2026-11-20", endsOn: "2026-11-20", createdByUserId: userId, updatedByUserId: userId },
  })));
  const feedLock = (tx: { $executeRaw: typeof prisma.$executeRaw }) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${feedLockKey(feed.id)}))`;

  // 1. Advisory lock taken: the bulk change waits for a holder of the feed's lock.
  let finished = false;
  let waiting = 0;
  let pending: Promise<unknown> = Promise.resolve();
  await prisma.$transaction(async (holder) => {
    await feedLock(holder);
    pending = bulk([a.id, b.id], { action: "setCategory", category: "Youth" }).then(() => { finished = true; });
    await sleep(600);
    assert(!finished, "the bulk change waits while another transaction holds the feed's lock");
    const rows = await holder.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    waiting = Number(rows[0].n);
    // 2. Re-read under the lock: this change commits while the bulk change waits.
    await holder.calendarEntry.update({ where: { id: b.id }, data: { category: "Youth" } });
  });
  assert(waiting >= 1, "pg_locks shows the bulk change waiting on an advisory lock");
  await pending;
  assert(finished, "the bulk change ran once the lock was released");
  const afterCategory = await prisma.calendarEntry.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { title: "asc" } });
  assert(afterCategory.every((row) => row.category === "Youth"), "both entries have the category");
  const audit = await prisma.auditLog.findMany({ where: { actorUserId: userId, action: "CALENDAR_ENTRIES_BULK_UPDATED" } });
  assert(audit.length === 1, "one summary audit row was written");
  const ids = (audit[0].metadata as { entryIds: string[] }).entryIds;
  assert(ids.length === 1 && ids[0] === a.id, "the audit row lists only the entry that changed (B already had it when the lock was released)");

  // 3. Re-read under the lock, with a state change that matters: publish an entry meanwhile.
  await prisma.$transaction(async (holder) => {
    await feedLock(holder);
    pending = bulk([c.id], { action: "publish" });
    await sleep(400);
    await holder.calendarEntry.update({ where: { id: c.id }, data: { isPublished: true } });
  });
  const published = await pending as Awaited<ReturnType<typeof bulk>>;
  assert(published.result.changed === 0 && published.result.skipped[0]?.reason === "Already published.", "the plan saw the row as committed under the lock");

  // 4. A refresh keeps the bulk-set category and records no local edit.
  feedBody = ics([
    { uid: "a@cbulk.test", title: "Imported A renamed", day: "20261110" },
    { uid: "b@cbulk.test", title: "Imported B", day: "20261111" },
    { uid: "c@cbulk.test", title: "Imported C", day: "20261112" },
  ]);
  await syncCalendarFeed(feed.id, { actorUserId: userId, transport, resolve });
  const refreshed = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: a.id } });
  assert(refreshed.title === "Imported A renamed", "the refresh still updates imported fields");
  assert(refreshed.category === "Youth", "the refresh kept the bulk-set category");
  assert(refreshed.locallyEditedFields.length === 0, "a bulk category records no local-edit mark");

  // 5. A sync racing a bulk change: never removed-and-published, and a bulk hide survives.
  const roundsFeed = (withC: boolean) => ics([
    { uid: "a@cbulk.test", title: "Imported A renamed", day: "20261110" },
    { uid: "b@cbulk.test", title: "Imported B", day: "20261111" },
    ...(withC ? [{ uid: "c@cbulk.test", title: "Imported C", day: "20261112" }] : []),
  ]);
  for (let round = 0; round < 8; round += 1) {
    await prisma.calendarEntry.update({ where: { id: c.id }, data: { isPublished: false, isHiddenLocally: false, sourceRemovedAt: null } });
    feedBody = roundsFeed(false); // C leaves the feed
    await Promise.all([
      bulk([c.id, a.id], { action: "publish" }),
      syncCalendarFeed(feed.id, { actorUserId: userId, transport, resolve }),
    ]);
    const row = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: c.id } });
    assert(!(row.sourceRemovedAt && row.isPublished), `round ${round}: an entry removed from its feed is never left published`);
    feedBody = roundsFeed(true); // C returns
    await syncCalendarFeed(feed.id, { actorUserId: userId, transport, resolve });
  }
  await bulk([a.id], { action: "hide" });
  feedBody = ics([{ uid: "a@cbulk.test", title: "Imported A renamed again", day: "20261110" }, { uid: "b@cbulk.test", title: "Imported B", day: "20261111" }, { uid: "c@cbulk.test", title: "Imported C", day: "20261112" }]);
  await syncCalendarFeed(feed.id, { actorUserId: userId, transport, resolve });
  const hidden = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: a.id } });
  assert(hidden.isHiddenLocally && hidden.title === "Imported A renamed again", "a bulk hide survives a refresh that still updates the title");

  // 6. Hide and unhide only touch imported entries; the rest are skipped with a reason.
  const mixed = await bulk([staff[0].id, b.id], { action: "hide" });
  assert(mixed.result.changed === 1 && mixed.result.skipped[0].reason === "Only imported entries can be hidden or unhidden.", "a staff entry is skipped when hiding");

  // 7. The cap: 500 in one request, 501 refused.
  await prisma.calendarEntry.createMany({
    data: Array.from({ length: 501 }, (_, index) => ({ id: `${P}_bulk_${index}`, title: `Bulk ${index}`, startsOn: "2026-12-01", endsOn: "2026-12-01", createdByUserId: userId, updatedByUserId: userId })),
  });
  const manyIds = Array.from({ length: 501 }, (_, index) => `${P}_bulk_${index}`);
  assert(!calendarBulkSchema.safeParse({ ids: manyIds, change: { action: "publish" } }).success, "501 entries are refused");
  const big = await bulk(manyIds.slice(0, 500), { action: "publish" });
  assert(big.result.changed === 500, `500 entries were changed in one request (got ${big.result.changed})`);
  const live = await prisma.calendarEntry.count({ where: { id: { in: manyIds.slice(0, 500) }, isPublished: true } });
  assert(live === 500 && !(await prisma.calendarEntry.findUniqueOrThrow({ where: { id: manyIds[500] } })).isPublished, "exactly the 500 asked for were published");

  console.log("calendar bulk: all checks passed");
}

main()
  .then(async () => { await cleanup(); await prisma.$disconnect(); })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
