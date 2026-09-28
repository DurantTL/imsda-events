import { describe, expect, it } from "vitest";
import {
  canBeWillingDriver,
  isSelfNomination,
  willingToDriveAllowed,
} from "@/modules/driver-verification/domain";
import { driverClearanceSchema } from "@/modules/driver-verification/schemas";

describe("driver verification rules (#491)", () => {
  it("only staff and adults can be willing drivers", () => {
    expect(canBeWillingDriver("STAFF")).toBe(true);
    expect(canBeWillingDriver("ADULT")).toBe(true);
    expect(canBeWillingDriver("YOUTH")).toBe(false);
    expect(canBeWillingDriver("UNDERAGE")).toBe(false);
  });

  it("allows willingToDrive false on any type, but true only for staff and adults", () => {
    expect(willingToDriveAllowed("YOUTH", false)).toBe(true);
    expect(willingToDriveAllowed("YOUTH", undefined)).toBe(true);
    expect(willingToDriveAllowed("YOUTH", true)).toBe(false);
    expect(willingToDriveAllowed("UNDERAGE", true)).toBe(false);
    expect(willingToDriveAllowed("STAFF", true)).toBe(true);
    expect(willingToDriveAllowed("ADULT", true)).toBe(true);
  });

  it("treats reviewing your own record as self-nomination, whatever your role", () => {
    expect(isSelfNomination("person-1", "person-1")).toBe(true);
    expect(isSelfNomination("person-1", "person-2")).toBe(false);
    // An actor with no linked Person can never match a real target.
    expect(isSelfNomination(null, "person-1")).toBe(false);
  });

  it("requires a note on an override, and never accepts a license or insurance field (#544)", () => {
    const base = { clearedToTransport: true, note: "Confirmed by phone." };
    expect(driverClearanceSchema.safeParse(base).success).toBe(true);
    expect(driverClearanceSchema.safeParse({ ...base, note: "   " }).success).toBe(false);
    expect(driverClearanceSchema.safeParse({ clearedToTransport: true }).success).toBe(false);
    // .strict() refuses any field this route was never meant to carry, including a license or insurance number.
    expect(driverClearanceSchema.safeParse({ ...base, licenseNumber: "D1234567" }).success).toBe(false);
    expect(driverClearanceSchema.safeParse({ ...base, insuranceNumber: "INS-1" }).success).toBe(false);
  });
});
