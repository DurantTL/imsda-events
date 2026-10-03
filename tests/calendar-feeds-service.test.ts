import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown> & { id: string }>,
  feeds: [] as Array<Record<string, unknown> & { id: string }>,
  entryWrites: 0,
  audits: [] as Array<Record<string, unknown>>,
  nextId: 1,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
// A reversible stand-in; the real box needs an environment key. What matters here is that only the sealed form is stored.
vi.mock("@/lib/secret-box", () => ({
  SecretBoxError: class SecretBoxError extends Error {},
  isSecretEncryptionConfigured: () => true,
  sealSecret: (value: string) => `v1.${Buffer.from(value).toString("base64url")}`,
  openSecret: (sealed: string) => Buffer.from(String(sealed).slice(3), "base64url").toString("utf8"),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: async (entry: Record<string, unknown>) => { state.audits.push(entry); } }));
vi.mock("@/lib/prisma", () => {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean => Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Array<Record<string, unknown>>).some((branch) => matches(row, branch));
    if (key === "id" && condition && typeof condition === "object" && "in" in condition) return (condition as { in: string[] }).in.includes(String(row.id));
    if (condition && typeof condition === "object" && "not" in (condition as object)) return row[key] !== (condition as { not: unknown }).not;
    return row[key] === condition;
  });
  const entryApi = {
    findMany: async ({ where }: { where?: Record<string, unknown> }) => state.entries.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findUnique: async ({ where }: { where: { id: string } }) => state.entries.find((row) => row.id === where.id) ?? null,
    createMany: async ({ data }: { data: Row[] }) => {
      state.entryWrites += 1;
      for (const row of data) {
        state.entries.push({
          sourceRemovedAt: null, sourceRemovedWasPublished: false, locallyEditedFields: [], isHiddenLocally: false,
          linkUrl: null, updatedAt: new Date(), sourceFeed: null, ...row, id: `entry-${state.nextId++}`,
        });
      }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      state.entryWrites += 1;
      Object.assign(state.entries.find((row) => row.id === where.id)!, data);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.entryWrites += 1;
      for (const row of state.entries.filter((candidate) => matches(candidate, where))) Object.assign(row, data);
    },
  };
  const feedApi = {
    findMany: async (args: { where?: Record<string, unknown> } = {}) => state.feeds
      .filter((row) => matches(row, args.where))
      .sort((a, b) => (a.lastFetchedAt ? (a.lastFetchedAt as Date).getTime() : -1) - (b.lastFetchedAt ? (b.lastFetchedAt as Date).getTime() : -1))
      .map((row) => ({ ...row, _count: { entries: state.entries.filter((entry) => entry.sourceFeedId === row.id).length } })),
    findUnique: async ({ where }: { where: { id: string } }) => state.feeds.find((row) => row.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { ...data, id: `feed-${state.nextId++}`, lastSucceededAt: null, lastFetchedAt: null, lastStatus: null, lastError: null, lastItemCount: null };
      state.feeds.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = state.feeds.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      state.feeds = state.feeds.filter((row) => row.id !== where.id);
      for (const entry of state.entries.filter((candidate) => candidate.sourceFeedId === where.id)) entry.sourceFeedId = null;
    },
  };
  const client = { calendarEntry: entryApi, calendarFeed: feedApi, $executeRaw: async () => 1, $transaction: async (run: (tx: unknown) => unknown) => run(client) };
  return { getPrisma: () => client };
});

import { CalendarError } from "@/modules/calendar/repository";
import { createCalendarFeed, deleteCalendarFeed, listCalendarFeeds, previewCalendarFeed, refreshDueCalendarFeeds, resetCalendarEntryToSource, setCalendarEntryHidden, syncCalendarFeed, updateCalendarFeed } from "@/modules/calendar/feeds";
import type { FeedTransport } from "@/modules/calendar/feed-fetch";

const ics = readFileSync(new URL("./fixtures/calendar-feed.ics", import.meta.url), "utf8");
const privateUrl = "https://calendar.example.test/ical/private-abc123SECRET/basic.ics";
const resolve = async () => ["93.184.216.34"];
let body = ics;
const transport: FeedTransport = async () => ({ status: 200, location: null, body });
const deps = { transport, resolve };
const entriesOf = (feedId: string) => state.entries.filter((entry) => entry.sourceFeedId === feedId);
const input = { name: "Synthetic Google calendar", url: privateUrl, defaultCategory: "Conference", defaultEntryType: "STANDARD" as const, publishNewItems: false, isEnabled: true, refreshMinutes: 60 };

async function addFeed() {
  await createCalendarFeed(input, "admin-1");
  return state.feeds[state.feeds.length - 1].id;
}

beforeEach(() => {
  state.entries = [];
  state.feeds = [];
  state.entryWrites = 0;
  state.audits = [];
  state.nextId = 1;
  body = ics;
});

describe("imported calendar feeds", () => {
  it("stores the address sealed and only ever lists its hint", async () => {
    const feeds = await createCalendarFeed(input, "admin-1");
    const stored = JSON.stringify(state.feeds);
    expect(stored).not.toContain("private-abc123SECRET");
    expect(state.feeds[0].sealedUrl).toMatch(/^v1\./);
    expect(JSON.stringify(feeds)).not.toMatch(/SECRET|sealedUrl|v1\./);
    expect(feeds[0]).toMatchObject({ urlHint: "calendar.example.test….ics", imported: false });
    expect(JSON.stringify(state.audits)).not.toContain("SECRET");
  });

  it("rewrites webcal:// and refuses unsafe addresses", async () => {
    await createCalendarFeed({ ...input, url: "webcal://calendar.example.test/ical/x/basic.ics" }, "admin-1");
    expect(Buffer.from(String(state.feeds[0].sealedUrl).slice(3), "base64url").toString()).toMatch(/^https:\/\//);
    for (const url of ["http://calendar.example.test/a.ics", "https://127.0.0.1/a.ics", "https://u:p@calendar.example.test/a.ics"]) {
      await expect(createCalendarFeed({ ...input, url }, "admin-1")).rejects.toMatchObject({ code: "INVALID_FEED" });
    }
  });

  it("keeps the saved address when an edit leaves it blank", async () => {
    const feedId = await addFeed();
    const sealed = state.feeds[0].sealedUrl;
    await updateCalendarFeed(feedId, { name: "Renamed", url: "" }, "admin-1");
    expect(state.feeds[0]).toMatchObject({ name: "Renamed", sealedUrl: sealed });
    await updateCalendarFeed(feedId, { url: "https://calendar.example.test/ical/new/basic.ics" }, "admin-1");
    expect(state.feeds[0].sealedUrl).not.toBe(sealed);
  });

  it("previews without writing anything", async () => {
    const feedId = await addFeed();
    const preview = await previewCalendarFeed(feedId, deps);
    expect(preview.counts.create).toBeGreaterThan(5);
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(state.entries).toHaveLength(0);
    expect(state.entryWrites).toBe(0);
    expect(state.feeds[0].lastFetchedAt).toBeNull();
  });

  it("imports, then a second run writes no entries at all", async () => {
    const feedId = await addFeed();
    const first = await syncCalendarFeed(feedId, { ...deps, actorUserId: "admin-1" });
    expect(first.create).toBeGreaterThan(5);
    expect(entriesOf(feedId).length).toBe(first.create);
    expect(entriesOf(feedId).every((entry) => entry.isPublished === false && entry.category === "Conference")).toBe(true);
    expect(state.feeds[0]).toMatchObject({ lastStatus: "OK", lastError: null });
    expect(state.feeds[0].lastSucceededAt).toBeInstanceOf(Date);

    state.entryWrites = 0;
    const second = await syncCalendarFeed(feedId, deps);
    expect(second).toMatchObject({ create: 0, update: 0, remove: 0, unchanged: first.create });
    expect(state.entryWrites).toBe(0);
  });

  it("keeps a local edit across a refresh and a hidden item hidden", async () => {
    const feedId = await addFeed();
    await syncCalendarFeed(feedId, deps);
    const camporee = entriesOf(feedId).find((entry) => entry.sourceUid === "allday-1@synthetic.test")!;
    Object.assign(camporee, { title: "Our title", locallyEditedFields: ["title"], isHiddenLocally: true });
    body = ics.replace("SUMMARY:Synthetic Camporee", "SUMMARY:Google's title").replace("Three days outdoors.", "Now four days.");
    await syncCalendarFeed(feedId, deps);
    expect(camporee).toMatchObject({ title: "Our title", description: "Now four days.", isHiddenLocally: true });
  });

  it("unpublishes what left the feed and relinks it, as the same row, when it returns", async () => {
    const feedId = await addFeed();
    await syncCalendarFeed(feedId, deps);
    const camporee = entriesOf(feedId).find((entry) => entry.sourceUid === "allday-1@synthetic.test")!;
    camporee.isPublished = true;
    const id = camporee.id;
    const count = entriesOf(feedId).length;

    body = ics.replace(/BEGIN:VEVENT\r?\nUID:allday-1@synthetic\.test[\s\S]*?END:VEVENT\r?\n/, "");
    const removed = await syncCalendarFeed(feedId, deps);
    expect(removed.remove).toBe(1);
    expect(entriesOf(feedId)).toHaveLength(count);
    expect(camporee).toMatchObject({ isPublished: false, sourceRemovedWasPublished: true });
    expect(camporee.sourceRemovedAt).toBeInstanceOf(Date);

    body = ics;
    await syncCalendarFeed(feedId, deps);
    expect(entriesOf(feedId).find((entry) => entry.id === id)).toMatchObject({ isPublished: true, sourceRemovedAt: null });
  });

  it("records a failure on the feed only, with no address, and changes no entry", async () => {
    const feedId = await addFeed();
    await syncCalendarFeed(feedId, deps);
    const before = JSON.stringify(state.entries);
    const failing: FeedTransport = async () => ({ status: 404, location: null, body: "" });
    await expect(syncCalendarFeed(feedId, { transport: failing, resolve })).rejects.toMatchObject({ code: "FEED_FETCH_FAILED", message: "The feed could not be reached (HTTP 404)." });
    expect(JSON.stringify(state.entries)).toBe(before);
    expect(state.feeds[0]).toMatchObject({ lastStatus: "FAILED", lastError: "The feed could not be reached (HTTP 404)." });
    expect(JSON.stringify(state.feeds[0].lastError)).not.toContain("SECRET");
    body = "<html>not a calendar</html>";
    await expect(syncCalendarFeed(feedId, deps)).rejects.toBeInstanceOf(CalendarError);
    expect(JSON.stringify(state.entries)).toBe(before);
  });

  it("deleting a feed keeps its entries as ordinary items, never making any appear", async () => {
    const feedId = await addFeed();
    await syncCalendarFeed(feedId, deps);
    const [a, b, c] = entriesOf(feedId);
    Object.assign(a, { isPublished: true });
    Object.assign(b, { isPublished: true, isHiddenLocally: true });
    Object.assign(c, { isPublished: true, sourceRemovedAt: new Date() });
    const count = state.entries.length;
    await deleteCalendarFeed(feedId, "admin-1");
    expect(state.feeds).toHaveLength(0);
    expect(state.entries).toHaveLength(count);
    expect(a).toMatchObject({ sourceFeedId: null, isPublished: true });
    expect(b).toMatchObject({ sourceFeedId: null, isPublished: false, isHiddenLocally: false });
    expect(c).toMatchObject({ sourceFeedId: null, isPublished: false, sourceRemovedAt: null });
    await expect(deleteCalendarFeed(feedId, "admin-1")).rejects.toMatchObject({ code: "FEED_NOT_FOUND" });
  });

  it("refreshes only enabled, imported, due feeds, at most three, and one failure doesn't stop the rest", async () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    const make = (id: string, extra: Record<string, unknown>) => state.feeds.push({
      id, name: id, sealedUrl: `v1.${Buffer.from(privateUrl).toString("base64url")}`, urlHint: "x", isEnabled: true, refreshMinutes: 60,
      lastSucceededAt: minutesAgo(500), lastFetchedAt: minutesAgo(500), defaultCategory: "", defaultEntryType: "STANDARD", publishNewItems: false, updatedByUserId: "admin-1", ...extra,
    });
    make("due-1", { lastFetchedAt: minutesAgo(400) });
    make("due-2", {});
    make("fresh", { lastFetchedAt: minutesAgo(10) });
    make("paused", { isEnabled: false });
    make("never-imported", { lastSucceededAt: null, lastFetchedAt: null });
    make("due-3", { lastFetchedAt: minutesAgo(300) });
    make("due-4", { lastFetchedAt: minutesAgo(200) });
    let calls = 0;
    const flaky: FeedTransport = async () => {
      calls += 1;
      return calls === 1 ? { status: 500, location: null, body: "" } : { status: 200, location: null, body: ics };
    };
    const result = await refreshDueCalendarFeeds(now, { transport: flaky, resolve });
    expect(result).toEqual({ due: 3, refreshed: 2, failed: 1 });
    // Oldest first: due-2 is tried first and fails; the others still run.
    expect(state.feeds.find((feed) => feed.id === "due-2")).toMatchObject({ lastStatus: "FAILED" });
    expect(state.feeds.find((feed) => feed.id === "due-1")).toMatchObject({ lastStatus: "OK" });
    expect(state.feeds.find((feed) => feed.id === "due-3")).toMatchObject({ lastStatus: "OK" });
    expect(state.feeds.find((feed) => feed.id === "fresh")?.lastStatus).toBeUndefined();
    expect(state.feeds.find((feed) => feed.id === "paused")?.lastStatus).toBeUndefined();
    expect(state.feeds.find((feed) => feed.id === "never-imported")?.lastStatus).toBeUndefined();
    expect(state.feeds.find((feed) => feed.id === "due-4")?.lastStatus).toBeUndefined();
  });

  it("hides and shows only imported items", async () => {
    const feedId = await addFeed();
    await syncCalendarFeed(feedId, deps);
    const imported = entriesOf(feedId)[0];
    state.entries.push({ id: "local-1", title: "Local", sourceFeedId: null, updatedAt: new Date(), locallyEditedFields: [] });
    await setCalendarEntryHidden(imported.id, true, "admin-1");
    expect(imported.isHiddenLocally).toBe(true);
    await setCalendarEntryHidden(imported.id, false, "admin-1");
    expect(imported.isHiddenLocally).toBe(false);
    await expect(setCalendarEntryHidden("local-1", true, "admin-1")).rejects.toMatchObject({ code: "NOT_IMPORTED" });
  });

  it("resets an item to the source's version and re-reads the feed", async () => {
    const feedId = await addFeed();
    await syncCalendarFeed(feedId, deps);
    const camporee = entriesOf(feedId).find((entry) => entry.sourceUid === "allday-1@synthetic.test")!;
    Object.assign(camporee, { title: "Edited", locallyEditedFields: ["title"] });
    const result = await resetCalendarEntryToSource(camporee.id, "admin-1", deps);
    expect(result.applied).toBe(true);
    expect(camporee).toMatchObject({ title: "Synthetic Camporee", locallyEditedFields: [] });
    // With the feed unreachable the reset still stands and applies at the next refresh.
    Object.assign(camporee, { title: "Edited again", locallyEditedFields: ["title"] });
    const offline = await resetCalendarEntryToSource(camporee.id, "admin-1", { transport: async () => ({ status: 503, location: null, body: "" }), resolve });
    expect(offline.applied).toBe(false);
    expect(camporee).toMatchObject({ locallyEditedFields: [], sourceHash: null });
    await syncCalendarFeed(feedId, deps);
    expect(camporee.title).toBe("Synthetic Camporee");
  });

  it("lists feeds without the sealed address", async () => {
    await addFeed();
    expect(Object.keys((await listCalendarFeeds())[0])).not.toContain("sealedUrl");
  });
});
