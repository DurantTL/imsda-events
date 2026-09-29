import { describe, expect, it } from "vitest";
import { locationUnavailableLabel } from "@/components/club-location-picker";

/**
 * A full location shows "Full" and can't be picked, unless a new registration
 * may join the event's waitlist for it (#599). The server decides again when
 * the registration is saved.
 */
const full = { full: true, phase: "OPEN" as const, isActive: true };

describe("location choices when a location is full", () => {
  it("says Full and blocks the pick by default, as before", () => {
    expect(locationUnavailableLabel(full, null, "loc-1")).toBe("Full");
    expect(locationUnavailableLabel({ ...full, waitlistOnFull: true }, null, "loc-1")).toBe("Full");
  });

  it("lets a new registration pick a full location when the event has a waitlist", () => {
    expect(locationUnavailableLabel({ ...full, waitlistOnFull: true }, null, "loc-1", true)).toBeNull();
  });

  it("still blocks a full location when the event has no waitlist, even for a registration that could join one", () => {
    expect(locationUnavailableLabel({ ...full, waitlistOnFull: false }, null, "loc-1", true)).toBe("Full");
    expect(locationUnavailableLabel(full, null, "loc-1", true)).toBe("Full");
  });

  it("never lets a waitlist open a location that is closed, not yet open, or inactive", () => {
    const waitlist = { ...full, waitlistOnFull: true };
    expect(locationUnavailableLabel({ ...waitlist, phase: "CLOSED" }, null, "loc-1", true)).toBe("Registration closed");
    expect(locationUnavailableLabel({ ...waitlist, phase: "UPCOMING" }, null, "loc-1", true)).toBe("Opens soon");
    expect(locationUnavailableLabel({ ...waitlist, isActive: false }, null, "loc-1", true)).toBe("No longer available");
  });

  it("keeps the club's own current location selectable while it is full for others", () => {
    expect(locationUnavailableLabel(full, "loc-1", "loc-1")).toBeNull();
  });
});
