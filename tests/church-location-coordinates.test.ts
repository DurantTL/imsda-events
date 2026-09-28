import { describe, expect, it } from "vitest";
import { displayCoordinate, numberOrNull } from "@/components/church-location-coordinates";

describe("church location coordinates (#480)", () => {
  it("turns a pin-derived value into the number the save sends", () => {
    expect(numberOrNull(displayCoordinate(41.586834567))).toBe(41.586835);
    expect(numberOrNull(displayCoordinate(-93.62497))).toBe(-93.62497);
  });

  it("sends null for a cleared field and keeps unparseable text for the server to reject", () => {
    expect(numberOrNull("   ")).toBeNull();
    expect(numberOrNull("north")).toBe("north");
  });
});
