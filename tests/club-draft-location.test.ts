import { describe, expect, it } from "vitest";
import { restoreDraftLocation, type DraftLocationOption } from "@/modules/club-registrations/draft-location";

const north: DraftLocationOption = { id: "north", name: "North Site", full: false, open: true, phase: "OPEN", isActive: true };
const south: DraftLocationOption = { id: "south", name: "South Site", full: false, open: true, phase: "OPEN", isActive: true };
const third: DraftLocationOption = { id: "third", name: "Third Site", full: false, open: true, phase: "OPEN", isActive: true };

describe("restoring the draft's location (#659)", () => {
  it("restores a location that is still pickable, with no message", () => {
    expect(restoreDraftLocation([north, south], "south")).toEqual({ locationId: "south", note: null });
  });

  it("explains a location that was removed instead of silently replacing it", () => {
    const result = restoreDraftLocation([north, south], "gone");
    expect(result.locationId).toBeNull();
    expect(result.note).toMatch(/no longer offered/);
  });

  it("explains a full or closed location, and does not pick another when the director has a choice", () => {
    const full = restoreDraftLocation([{ ...north, full: true }, south, third], "north");
    expect(full.locationId).toBeNull();
    expect(full.note).toBe("North Site is now full. Choose another location to continue.");
    const closed = restoreDraftLocation([{ ...north, open: false, phase: "CLOSED" }, south, third], "north");
    expect(closed.note).toBe("North Site is now closed for registration. Choose another location to continue.");
    const upcoming = restoreDraftLocation([{ ...north, open: false, phase: "UPCOMING" }, south, third], "north");
    expect(upcoming.note).toMatch(/not open for registration yet/);
  });

  it("names a closed location that is full but waitlisted as closed, and a deactivated one as unavailable", () => {
    const closedFull = { ...north, full: true, waitlistOnFull: true, open: false, phase: "CLOSED" };
    expect(restoreDraftLocation([closedFull, south, third], "north").note).toMatch(/now closed for registration/);
    expect(restoreDraftLocation([{ ...north, isActive: false }, south, third], "north").note).toMatch(/no longer available/);
  });

  it("keeps a full location the event will waitlist", () => {
    expect(restoreDraftLocation([{ ...north, full: true, waitlistOnFull: true }, south], "north").locationId).toBe("north");
  });

  it("still picks the only remaining option, with the explanation", () => {
    const result = restoreDraftLocation([{ ...north, full: true }, south], "north");
    expect(result.locationId).toBe("south");
    expect(result.note).toMatch(/now full/);
  });

  it("picks the only location when nothing was saved, and nothing when the event has none", () => {
    expect(restoreDraftLocation([north], null)).toEqual({ locationId: "north", note: null });
    expect(restoreDraftLocation([north, south], undefined)).toEqual({ locationId: null, note: null });
    expect(restoreDraftLocation([], "north")).toEqual({ locationId: null, note: null });
  });
});
