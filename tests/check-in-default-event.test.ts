import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/membership-repository", () => ({ listActiveEventPermissionsForUser: vi.fn() }));
vi.mock("@/modules/events/last-used-event", () => ({ readLastUsedEventId: vi.fn() }));
vi.mock("@/modules/events/repository", () => ({ listEventsForUser: vi.fn() }));

import { chooseCheckInEventId } from "@/modules/checkin/default-event";

const now = new Date("2026-09-28T12:00:00Z");
const past = new Date("2026-06-01T00:00:00Z");
const future = new Date("2026-12-01T00:00:00Z");

describe("chooseCheckInEventId (#470)", () => {
  it("returns null when no event grants check-in", () => {
    expect(chooseCheckInEventId([{ id: "a", endsAt: future, canCheckIn: false }], null, now)).toBeNull();
    expect(chooseCheckInEventId([], "a", now)).toBeNull();
  });

  it("prefers the remembered event only when it grants check-in", () => {
    const candidates = [
      { id: "a", endsAt: future, canCheckIn: true },
      { id: "b", endsAt: future, canCheckIn: true },
      { id: "c", endsAt: future, canCheckIn: false },
    ];
    expect(chooseCheckInEventId(candidates, "b", now)).toBe("b");
    expect(chooseCheckInEventId(candidates, "c", now)).toBe("a");
  });

  it("picks the nearest event that hasn't ended, else the most recent past one", () => {
    expect(chooseCheckInEventId([
      { id: "old", endsAt: past, canCheckIn: true },
      { id: "next", endsAt: future, canCheckIn: true },
    ], null, now)).toBe("next");
    expect(chooseCheckInEventId([
      { id: "older", endsAt: new Date("2026-01-01T00:00:00Z"), canCheckIn: true },
      { id: "old", endsAt: past, canCheckIn: true },
    ], null, now)).toBe("old");
  });
});
