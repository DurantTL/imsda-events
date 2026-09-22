import { describe, expect, it } from "vitest";
import {
  SWEEP_STALE_AFTER_MS,
  assessSweepHeartbeat,
} from "@/modules/operations/sweep-heartbeat";

const now = new Date("2026-10-09T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("outbox sweep heartbeat", () => {
  it("is ok while sweeps keep arriving", () => {
    expect(assessSweepHeartbeat({ lastSucceededAt: minutesAgo(4), lastFailedAt: null }, now))
      .toEqual({
        status: "ok",
        lastSucceededAt: minutesAgo(4).toISOString(),
        lastFailedAt: null,
        ageMs: 4 * 60_000,
      });
  });

  it("goes stale after three missed five-minute runs", () => {
    expect(SWEEP_STALE_AFTER_MS).toBe(15 * 60_000);
    expect(assessSweepHeartbeat({ lastSucceededAt: minutesAgo(15), lastFailedAt: null }, now).status)
      .toBe("ok");
    expect(assessSweepHeartbeat({ lastSucceededAt: minutesAgo(16), lastFailedAt: null }, now).status)
      .toBe("stale");
  });

  it("reports failing when the latest run failed", () => {
    expect(assessSweepHeartbeat({ lastSucceededAt: minutesAgo(10), lastFailedAt: minutesAgo(5) }, now).status)
      .toBe("failing");
    expect(assessSweepHeartbeat({ lastSucceededAt: null, lastFailedAt: minutesAgo(5) }, now).status)
      .toBe("failing");
    // A later success clears an earlier failure.
    expect(assessSweepHeartbeat({ lastSucceededAt: minutesAgo(2), lastFailedAt: minutesAgo(5) }, now).status)
      .toBe("ok");
  });

  it("reports never when no sweep has reported", () => {
    expect(assessSweepHeartbeat(null, now)).toEqual({
      status: "never",
      lastSucceededAt: null,
      lastFailedAt: null,
      ageMs: null,
    });
  });
});
