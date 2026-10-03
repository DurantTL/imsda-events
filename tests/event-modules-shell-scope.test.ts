import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eventsNeedingModuleState, MODULE_STATE_AFTER_EVENT_DAYS } from "@/modules/event-modules/shell-scope";

/** Which events the staff shell loads module state for (#741 review). Synthetic data only. */
const now = new Date("2026-10-03T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
const event = (id: string, endsAt: Date | null) => ({ id, timezone: "America/Chicago", endsAt });

describe("eventsNeedingModuleState", () => {
  it("keeps events that have not ended, and events that ended within 60 days (post-event features stay in the launcher)", () => {
    expect(MODULE_STATE_AFTER_EVENT_DAYS).toBe(60);
    const events = [event("upcoming", daysAgo(-30)), event("running", daysAgo(-1)), event("ended-10", daysAgo(10)), event("ended-59", daysAgo(59))];
    expect(eventsNeedingModuleState(events, null, now)).toEqual(["upcoming", "running", "ended-10", "ended-59"]);
  });

  it("leaves out events that ended more than 60 days ago", () => {
    expect(eventsNeedingModuleState([event("ended-61", daysAgo(61)), event("ended-400", daysAgo(400))], null, now)).toEqual([]);
  });

  it("keeps an old event whatever its date when it is the default or selected event", () => {
    const events = [event("ended-400", daysAgo(400)), event("ended-90", daysAgo(90))];
    expect(eventsNeedingModuleState(events, "ended-400", now)).toEqual(["ended-400"]);
  });

  it("keeps an event with no end date", () => {
    expect(eventsNeedingModuleState([event("undated", null)], null, now)).toEqual(["undated"]);
  });
});
