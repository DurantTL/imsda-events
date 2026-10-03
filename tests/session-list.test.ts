import { describe, expect, it } from "vitest";
import { visibleSessionLimit, visibleSessions } from "@/components/session-list";

/** The Profile page's signed-in devices list (#741): five, then Show all. Synthetic data only. */
const sessions = (count: number, currentIndex = -1) => Array.from({ length: count }, (_, index) => ({ id: `s${index}`, isCurrent: index === currentIndex }));

describe("visibleSessions", () => {
  it("shows five by default", () => {
    expect(visibleSessionLimit).toBe(5);
    expect(visibleSessions(sessions(8), false)).toHaveLength(5);
  });

  it("shows everything when there are five or fewer", () => {
    expect(visibleSessions(sessions(5), false)).toHaveLength(5);
    expect(visibleSessions(sessions(2), false)).toHaveLength(2);
    expect(visibleSessions([], false)).toEqual([]);
  });

  it("shows all of them once expanded", () => {
    expect(visibleSessions(sessions(8), true)).toHaveLength(8);
  });

  it("keeps this device in the five when the list had it later, and does not duplicate it", () => {
    const shown = visibleSessions(sessions(9, 7), false);
    expect(shown).toHaveLength(5);
    expect(shown[0].id).toBe("s7");
    expect(new Set(shown.map((session) => session.id)).size).toBe(5);
  });

  it("leaves the order alone when this device is already among the first five", () => {
    expect(visibleSessions(sessions(9, 2), false).map((session) => session.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });
});
