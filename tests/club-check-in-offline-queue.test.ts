import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineCheckInQueue } from "@/components/use-offline-check-in-queue";
import {
  pendingAttendeeIds,
  selectedPendingAttendeeIds,
  type ClubCheckInAttendeeView,
} from "@/components/club-check-in-panel";
import {
  checkInSequentially,
  sequentialCheckInSummary,
  type SequentialCheckInProgress,
} from "@/modules/checkin/bulk-check-in";
import {
  offlineCheckInStorageKey,
  type OfflineCheckInQueueItem,
} from "@/modules/checkin/domain";

/**
 * Q1 (#412): a club check-in is a series of single check-ins through the
 * real offline queue hook. The hook is rendered once with
 * renderToStaticMarkup (no DOM in this suite): refs and callbacks work, and
 * the captured callbacks stay callable, so these tests drive the exact
 * `requestCheckIn` / `retryAll` the check-in page uses. Browser storage,
 * connectivity, UUIDs and fetch are stubbed; all data is synthetic.
 */

const eventId = "event_synthetic_1";
const storageKey = offlineCheckInStorageKey(eventId);

type QueueApi = ReturnType<typeof useOfflineCheckInQueue>;

let store: Map<string, string>;
let nav: { onLine: boolean };
let uuidCounter: number;
let confirmed: Array<{ attendeeId: string; checkedInAt: string }>;

function renderQueue(): QueueApi {
  let captured: QueueApi | null = null;
  function Harness() {
    captured = useOfflineCheckInQueue({
      eventId,
      onConfirmed: (attendeeId, checkedInAt) => {
        confirmed.push({ attendeeId, checkedInAt });
      },
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!captured) throw new Error("hook did not render");
  return captured;
}

function storedQueue(): OfflineCheckInQueueItem[] {
  const raw = store.get(storageKey);
  return raw ? JSON.parse(raw) as OfflineCheckInQueueItem[] : [];
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function confirmedResponse() {
  return jsonResponse(200, {
    checkedIn: true,
    disposition: "CREATED",
    checkIn: { checkedInAt: "2026-10-10T14:00:00.000Z", undoneAt: null },
  });
}

function attendeeIdFromUrl(url: string) {
  const match = /\/attendees\/([^/]+)\/check-in$/.exec(url);
  if (!match) throw new Error(`unexpected URL ${url}`);
  return decodeURIComponent(match[1]);
}

function postedCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    attendeeId: attendeeIdFromUrl(String(url)),
    method: (init as RequestInit).method,
    idempotencyKey: (JSON.parse(String((init as RequestInit).body)) as { idempotencyKey: string }).idempotencyKey,
  }));
}

beforeEach(() => {
  store = new Map();
  nav = { onLine: false };
  uuidCounter = 0;
  confirmed = [];
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("crypto", {
    randomUUID: () => {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("club check-in through the real offline queue (#412)", () => {
  it("queues a whole club offline once, keeps the same keys on a repeat, and replays those keys on reconnect", async () => {
    const fetchMock = vi.fn(async () => confirmedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const queue = renderQueue();
    const club = ["att_a", "att_b", "att_c"];

    // (a) Offline: three separate queue items, three distinct keys, no network.
    const first = await checkInSequentially(club, queue.requestCheckIn);
    expect(first).toMatchObject({ confirmed: 0, queued: 3, needsReview: 0 });
    const afterFirst = storedQueue();
    expect(afterFirst).toHaveLength(3);
    expect(afterFirst.map((item) => item.attendeeId).sort()).toEqual(club);
    expect(afterFirst.every((item) => item.state === "QUEUED")).toBe(true);
    const keyByAttendee = new Map(afterFirst.map((item) => [item.attendeeId, item.idempotencyKey]));
    expect(new Set(keyByAttendee.values()).size).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();

    // (b) Repeat tap while still offline: nothing duplicated, same keys.
    const repeat = await checkInSequentially(club, queue.requestCheckIn);
    expect(repeat).toMatchObject({ confirmed: 0, queued: 3, needsReview: 0 });
    const afterRepeat = storedQueue();
    expect(afterRepeat).toHaveLength(3);
    expect(new Map(afterRepeat.map((item) => [item.attendeeId, item.idempotencyKey]))).toEqual(keyByAttendee);
    expect(fetchMock).not.toHaveBeenCalled();

    // (c) Back online: exactly one POST per attendee with its original key.
    nav.onLine = true;
    await queue.retryAll(false);
    const posts = postedCalls(fetchMock);
    expect(posts).toHaveLength(3);
    expect(posts.every((post) => post.method === "POST")).toBe(true);
    for (const post of posts) {
      expect(post.idempotencyKey).toBe(keyByAttendee.get(post.attendeeId));
    }
    expect(posts.map((post) => post.attendeeId).sort()).toEqual(club);
    expect(storedQueue()).toEqual([]);
    expect(store.has(storageKey)).toBe(false);
    expect(confirmed.map((entry) => entry.attendeeId).sort()).toEqual(club);
  });

  it("partial check-in sends only the selected attendees", async () => {
    nav.onLine = true;
    const fetchMock = vi.fn(async () => confirmedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const queue = renderQueue();
    const roster: ClubCheckInAttendeeView[] = ["att_a", "att_b", "att_c", "att_d"].map((id) => ({
      id,
      firstName: "Synthetic",
      lastName: id,
      attendeeType: "YOUTH",
      checkedIn: false,
      backgroundFlagged: false,
    }));

    const ids = selectedPendingAttendeeIds(roster, new Set(["att_d", "att_b"]));
    const outcome = await checkInSequentially(ids, queue.requestCheckIn);

    expect(outcome).toMatchObject({ confirmed: 2, queued: 0, needsReview: 0 });
    expect(postedCalls(fetchMock).map((post) => post.attendeeId)).toEqual(["att_b", "att_d"]);
    expect(storedQueue()).toEqual([]);
  });

  it("keeps going after a 500 and a 409, counting each outcome and keeping the right queue state", async () => {
    nav.onLine = true;
    const fetchMock = vi.fn(async (url: string) => {
      const attendeeId = attendeeIdFromUrl(url);
      if (attendeeId === "att_down") return jsonResponse(500, { error: "INTERNAL" });
      if (attendeeId === "att_cancelled") {
        return jsonResponse(409, {
          error: "REGISTRATION_NOT_ELIGIBLE",
          message: "This registration is no longer eligible for check-in.",
        });
      }
      return confirmedResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const queue = renderQueue();
    const ids = ["att_a", "att_down", "att_cancelled", "att_d"];
    const progress: SequentialCheckInProgress[] = [];

    const outcome = await checkInSequentially(ids, queue.requestCheckIn, (step) => progress.push(step));

    expect(postedCalls(fetchMock).map((post) => post.attendeeId)).toEqual(ids);
    expect(outcome).toMatchObject({ confirmed: 2, queued: 1, needsReview: 1 });
    expect(outcome.perAttendee.att_down.status).toBe("QUEUED");
    expect(outcome.perAttendee.att_cancelled.status).toBe("CONFLICT");
    expect(progress.map((step) => `${step.current}/${step.total}`)).toEqual(["1/4", "2/4", "3/4", "4/4"]);

    const saved = new Map(storedQueue().map((item) => [item.attendeeId, item]));
    expect([...saved.keys()].sort()).toEqual(["att_cancelled", "att_down"]);
    expect(saved.get("att_down")).toMatchObject({ state: "QUEUED", lastErrorCode: "SERVER_UNAVAILABLE" });
    expect(saved.get("att_cancelled")).toMatchObject({ state: "CONFLICT", lastErrorCode: "REGISTRATION_NOT_ELIGIBLE" });

    // The attendee needing review is named, and "Check in all" won't retry them.
    expect(sequentialCheckInSummary(ids, outcome, (id) => `Name ${id}`)).toBe(
      "Checked in 2 of 4, 1 queued offline (not confirmed yet), 1 needs review: Name att_cancelled.",
    );
    const roster: ClubCheckInAttendeeView[] = ids.map((id) => ({
      id,
      firstName: "Synthetic",
      lastName: id,
      attendeeType: "YOUTH",
      checkedIn: outcome.perAttendee[id].status === "CONFIRMED",
      backgroundFlagged: false,
      savedState: saved.get(id)?.state,
    }));
    expect(pendingAttendeeIds(roster)).toEqual(["att_down"]);
  });
});

describe("checkInSequentially (#412)", () => {
  it("records a throw as needing review and carries on with the rest", async () => {
    const calls: string[] = [];
    const outcome = await checkInSequentially(["x1", "x2", "x3"], async (id) => {
      calls.push(id);
      if (id === "x2") throw new Error("Storage exploded");
      return { status: "CONFIRMED", message: "ok", checkedInAt: "2026-10-10T14:00:00.000Z" };
    });

    expect(calls).toEqual(["x1", "x2", "x3"]);
    expect(outcome).toMatchObject({ confirmed: 2, queued: 0, needsReview: 1 });
    expect(outcome.perAttendee.x2).toEqual({ status: "CONFLICT", message: "Storage exploded" });
  });

  it("never starts the next attendee before the previous one finishes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await checkInSequentially(["x1", "x2", "x3"], async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { status: "QUEUED", message: "saved" };
    });
    expect(maxInFlight).toBe(1);
  });

  it("summarises an all-confirmed run without review or queue clauses", () => {
    expect(sequentialCheckInSummary(["x1"], {
      perAttendee: { x1: { status: "CONFIRMED", message: "ok" } },
      confirmed: 1,
      queued: 0,
      needsReview: 0,
    }, (id) => id)).toBe("Checked in 1 of 1.");
  });
});
