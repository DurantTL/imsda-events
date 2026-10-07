import { describe, expect, it } from "vitest";
import {
  LIVE_POLL_INTERVAL_MS,
  LIVE_POLL_MAX_BACKOFF_MS,
  LIVE_POLL_OVERLAP_MS,
  alreadyCheckedInMessage,
  applyLiveCheckInChanges,
  collapseCheckInChanges,
  nextLivePollDelay,
  nextLiveSince,
  parseLiveCheckInChanges,
} from "@/modules/checkin/live-changes";

const at = (iso: string) => new Date(iso);

describe("live check-in changes (#825)", () => {
  it("collapses rows to one final state per attendee, newest active row winning", () => {
    expect(collapseCheckInChanges([
      { registrationAttendeeId: "a", checkedInAt: at("2026-10-09T14:00:00Z"), undoneAt: at("2026-10-09T14:05:00Z") },
      { registrationAttendeeId: "a", checkedInAt: at("2026-10-09T14:06:00Z"), undoneAt: null },
      { registrationAttendeeId: "b", checkedInAt: at("2026-10-09T14:01:00Z"), undoneAt: at("2026-10-09T14:02:00Z") },
    ])).toEqual([
      ["a", "2026-10-09T14:06:00.000Z"],
      ["b", null],
    ]);
  });

  it("applies changes without touching unchanged rows or attendees this device is acting on", () => {
    const arrivals = [
      { id: "a", checkedIn: false, checkedInAt: null as string | null },
      { id: "b", checkedIn: true, checkedInAt: "2026-10-09T14:00:00.000Z" as string | null },
      { id: "c", checkedIn: false, checkedInAt: null as string | null },
    ];
    const next = applyLiveCheckInChanges(
      arrivals,
      [["a", "2026-10-09T14:06:00.000Z"], ["b", null], ["c", "2026-10-09T14:07:00.000Z"]],
      new Set(["c"]),
    );
    expect(next[0]).toEqual({ id: "a", checkedIn: true, checkedInAt: "2026-10-09T14:06:00.000Z" });
    expect(next[1]).toEqual({ id: "b", checkedIn: false, checkedInAt: null });
    expect(next[2]).toBe(arrivals[2]);
  });

  it("returns the same array for a quiet or already-applied poll", () => {
    const arrivals = [{ id: "a", checkedIn: true, checkedInAt: "2026-10-09T14:06:00.000Z" as string | null }];
    expect(applyLiveCheckInChanges(arrivals, [])).toBe(arrivals);
    expect(applyLiveCheckInChanges(arrivals, [["a", "2026-10-09T14:06:00.000Z"]])).toBe(arrivals);
    expect(applyLiveCheckInChanges(arrivals, [["unknown", null]])).toBe(arrivals);
  });

  it("parses answers defensively", () => {
    expect(parseLiveCheckInChanges({ now: "2026-10-09T14:00:00.000Z", changes: [["a", null], ["b", "x"], [1, null], "z"] }))
      .toEqual({ now: "2026-10-09T14:00:00.000Z", changes: [["a", null]] });
    expect(parseLiveCheckInChanges({ now: "nope", changes: [] })).toBeNull();
    expect(parseLiveCheckInChanges(null)).toBeNull();
  });

  it("starts each poll a safety overlap before the last answer", () => {
    expect(nextLiveSince("2026-10-09T14:00:30.000Z")).toBe(
      new Date(Date.parse("2026-10-09T14:00:30.000Z") - LIVE_POLL_OVERLAP_MS).toISOString(),
    );
    expect(nextLiveSince("garbage")).toBeNull();
  });

  it("polls every few seconds and backs off, capped, while failing", () => {
    expect(nextLivePollDelay(0)).toBe(LIVE_POLL_INTERVAL_MS);
    expect(LIVE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(3_000);
    expect(LIVE_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    expect(nextLivePollDelay(1)).toBeGreaterThan(nextLivePollDelay(0));
    expect(nextLivePollDelay(20)).toBe(LIVE_POLL_MAX_BACKOFF_MS);
  });

  it("keeps a quiet poll answer small", () => {
    const quiet = JSON.stringify({ now: "2026-10-09T14:00:00.000Z", changes: [] });
    expect(quiet.length).toBeLessThan(80);
    const busy = JSON.stringify({
      now: "2026-10-09T14:00:00.000Z",
      changes: Array.from({ length: 20 }, (_, index) => [`cm${String(index).padStart(23, "0")}`, "2026-10-09T14:00:00.000Z"]),
    });
    expect(busy.length).toBeLessThan(1_200);
  });

  it("words the already-checked-in message with the time and the staff name when known", () => {
    const withName = alreadyCheckedInMessage("2026-10-09T14:04:00.000Z", "Dana Staff", "en-US");
    expect(withName).toMatch(/^Already checked in at \d{1,2}:\d{2}\s?(AM|PM) by Dana Staff\.$/);
    expect(alreadyCheckedInMessage("2026-10-09T14:04:00.000Z", null, "en-US")).toMatch(/^Already checked in at \d{1,2}:\d{2}\s?(AM|PM)\.$/);
  });
});
