import { beforeEach, describe, expect, it, vi } from "vitest";

const secret = "https://calendar.example.test/ical/private-abc123SECRET/basic.ics";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  listCalendarFeeds: vi.fn(),
  createCalendarFeed: vi.fn(),
  updateCalendarFeed: vi.fn(),
  deleteCalendarFeed: vi.fn(),
  previewCalendarFeed: vi.fn(),
  syncCalendarFeed: vi.fn(),
  setCalendarEntryHidden: vi.fn(),
  resetCalendarEntryToSource: vi.fn(),
  listCalendarEntries: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/calendar/feeds", () => ({
  listCalendarFeeds: mocks.listCalendarFeeds,
  createCalendarFeed: mocks.createCalendarFeed,
  updateCalendarFeed: mocks.updateCalendarFeed,
  deleteCalendarFeed: mocks.deleteCalendarFeed,
  previewCalendarFeed: mocks.previewCalendarFeed,
  syncCalendarFeed: mocks.syncCalendarFeed,
  setCalendarEntryHidden: mocks.setCalendarEntryHidden,
  resetCalendarEntryToSource: mocks.resetCalendarEntryToSource,
}));
vi.mock("@/modules/calendar/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/calendar/repository")>("@/modules/calendar/repository");
  return { ...actual, listCalendarEntries: mocks.listCalendarEntries };
});

import { GET, POST } from "@/app/api/admin/calendar/feeds/route";
import { DELETE, PATCH } from "@/app/api/admin/calendar/feeds/[feedId]/route";
import { POST as PREVIEW } from "@/app/api/admin/calendar/feeds/[feedId]/preview/route";
import { POST as SYNC } from "@/app/api/admin/calendar/feeds/[feedId]/sync/route";
import { POST as SOURCE } from "@/app/api/admin/calendar/entries/[entryId]/source/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { CalendarError } from "@/modules/calendar/repository";

const request = (method: string, body?: unknown) => new Request("https://events.imsda.test/api/admin/calendar/feeds", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const feedCtx = { params: Promise.resolve({ feedId: "feed-1" }) };
const entryCtx = { params: Promise.resolve({ entryId: "entry-1" }) };
const valid = { name: "Synthetic Google calendar", url: secret };

const calls = () => [
  () => GET(request("GET")),
  () => POST(request("POST", valid)),
  () => PATCH(request("PATCH", { name: "x" }), feedCtx),
  () => DELETE(request("DELETE"), feedCtx),
  () => PREVIEW(request("POST"), feedCtx),
  () => SYNC(request("POST"), feedCtx),
  () => SOURCE(request("POST", { action: "hide" }), entryCtx),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.listCalendarFeeds.mockResolvedValue([{ id: "feed-1", name: "Synthetic", urlHint: "calendar.example.test….ics" }]);
  mocks.createCalendarFeed.mockResolvedValue([]);
  mocks.updateCalendarFeed.mockResolvedValue([]);
  mocks.deleteCalendarFeed.mockResolvedValue([]);
  mocks.previewCalendarFeed.mockResolvedValue({ counts: {}, rows: [], warnings: [], totalInFeed: 0 });
  mocks.syncCalendarFeed.mockResolvedValue({ create: 1, update: 0, revive: 0, remove: 0, unchanged: 0, warnings: [], totalInFeed: 1 });
  mocks.setCalendarEntryHidden.mockResolvedValue([]);
  mocks.resetCalendarEntryToSource.mockResolvedValue({ entries: [], applied: true });
  mocks.listCalendarEntries.mockResolvedValue([]);
});

describe("imported calendar routes", () => {
  it("is closed to anyone but a system administrator, and does nothing for them", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    for (const call of calls()) expect((await call()).status).toBe(403);
    for (const mock of [mocks.listCalendarFeeds, mocks.createCalendarFeed, mocks.updateCalendarFeed, mocks.deleteCalendarFeed, mocks.previewCalendarFeed, mocks.syncCalendarFeed, mocks.setCalendarEntryHidden, mocks.resetCalendarEntryToSource]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("refuses cross-origin writes before checking anything else", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    for (const call of calls().slice(1)) expect((await call()).status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });

  it("adds a feed as the signed-in administrator with the defaults", async () => {
    expect((await POST(request("POST", valid))).status).toBe(201);
    expect(mocks.createCalendarFeed).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Synthetic Google calendar", url: secret, publishNewItems: false, isEnabled: true, refreshMinutes: 60, defaultEntryType: "STANDARD" }),
      "admin-1",
    );
  });

  it("validates input and never echoes the address back", async () => {
    for (const body of [{ ...valid, refreshMinutes: 5 }, { ...valid, name: "" }, { ...valid, surprise: secret }, { name: "x", url: "" }]) {
      const response = await POST(request("POST", body));
      expect(response.status).toBe(400);
      expect(await response.text()).not.toMatch(/SECRET|calendar\.example/);
    }
    expect(mocks.createCalendarFeed).not.toHaveBeenCalled();
  });

  it("answers an unsafe or unreachable address with a message that omits it", async () => {
    mocks.createCalendarFeed.mockRejectedValue(new CalendarError("INVALID_FEED", "Calendar addresses must use https:// (or webcal://)."));
    const rejected = await POST(request("POST", valid));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toMatch(/SECRET/);

    mocks.syncCalendarFeed.mockRejectedValue(new CalendarError("FEED_FETCH_FAILED", "The feed could not be reached (HTTP 404)."));
    const failed = await SYNC(request("POST"), feedCtx);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "FEED_FETCH_FAILED", message: "The feed could not be reached (HTTP 404)." });
  });

  it("returns the hint and never the address from any success response", async () => {
    mocks.createCalendarFeed.mockResolvedValue([{ id: "feed-1", name: "Synthetic", urlHint: "calendar.example.test….ics" }]);
    const bodies = await Promise.all([GET(request("GET")), POST(request("POST", valid)), PATCH(request("PATCH", { url: secret }), feedCtx), SYNC(request("POST"), feedCtx), PREVIEW(request("POST"), feedCtx)].map(async (response) => (await response).text()));
    for (const body of bodies) expect(body).not.toMatch(/SECRET|private-abc/);
    expect(bodies[0]).toContain("urlHint");
  });

  it("reports a missing feed as 404 and a missing key as 503", async () => {
    mocks.previewCalendarFeed.mockRejectedValue(new CalendarError("FEED_NOT_FOUND", "That imported calendar could not be found."));
    expect((await PREVIEW(request("POST"), feedCtx)).status).toBe(404);
    mocks.createCalendarFeed.mockRejectedValue(new CalendarError("FEED_SECRET_MISSING", "needs the key"));
    expect((await POST(request("POST", valid))).status).toBe(503);
  });

  it("imports, previews, hides, shows and resets through the module", async () => {
    expect((await PREVIEW(request("POST"), feedCtx)).status).toBe(200);
    expect(mocks.previewCalendarFeed).toHaveBeenCalledWith("feed-1");
    expect((await SYNC(request("POST"), feedCtx)).status).toBe(200);
    expect(mocks.syncCalendarFeed).toHaveBeenCalledWith("feed-1", { actorUserId: "admin-1" });
    await SOURCE(request("POST", { action: "hide" }), entryCtx);
    expect(mocks.setCalendarEntryHidden).toHaveBeenCalledWith("entry-1", true, "admin-1");
    await SOURCE(request("POST", { action: "show" }), entryCtx);
    expect(mocks.setCalendarEntryHidden).toHaveBeenLastCalledWith("entry-1", false, "admin-1");
    await SOURCE(request("POST", { action: "reset" }), entryCtx);
    expect(mocks.resetCalendarEntryToSource).toHaveBeenCalledWith("entry-1", "admin-1");
    expect((await SOURCE(request("POST", { action: "explode" }), entryCtx)).status).toBe(400);
  });

  it("deleting a feed returns the kept entries too", async () => {
    mocks.listCalendarEntries.mockResolvedValue([{ id: "entry-1" }]);
    const response = await DELETE(request("DELETE"), feedCtx);
    expect(response.status).toBe(200);
    expect((await response.json()).entries).toEqual([{ id: "entry-1" }]);
    expect(mocks.deleteCalendarFeed).toHaveBeenCalledWith("feed-1", "admin-1");
  });
});
