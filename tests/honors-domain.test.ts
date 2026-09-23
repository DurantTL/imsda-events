import { describe, expect, it } from "vitest";
import { normalizeHonorCode, normalizeHonorText, offeringSlotConflict } from "@/modules/honors/domain";
import {
  honorInputSchema,
  honorOfferingInputSchema,
  honorOfferingUpdateSchema,
} from "@/modules/honors/schemas";

describe("honor offering slots", () => {
  const single = (sessionId: string) => ({ honorId: "knots", span: "SINGLE_SESSION" as const, sessionId });
  const all = { honorId: "knots", span: "ALL_SESSIONS" as const, sessionId: null };

  it("allows the same honor in different sessions", () => {
    expect(offeringSlotConflict(single("sunday"), [single("sabbath")])).toBeNull();
  });

  it("refuses the same honor twice in one session", () => {
    expect(offeringSlotConflict(single("sabbath"), [single("sabbath")])).toMatch(/already offered in that session/);
  });

  it("keeps an all-sessions honor out of single sessions, both ways", () => {
    expect(offeringSlotConflict(all, [single("sabbath")])).toMatch(/can't also be in a single session/);
    expect(offeringSlotConflict(single("sabbath"), [all])).toMatch(/all sessions/);
    expect(offeringSlotConflict(all, [all])).toMatch(/already offered across all sessions/);
  });

  it("ignores other honors", () => {
    expect(offeringSlotConflict(all, [{ ...single("sabbath"), honorId: "birds" }])).toBeNull();
  });

  it("normalizes names and codes", () => {
    expect(normalizeHonorText("  Basic   Rescue ")).toBe("basic rescue");
    expect(normalizeHonorCode(" ar-011 ")).toBe("AR-011");
  });
});

describe("honor input validation", () => {
  const offering = { honorId: "knots", span: "SINGLE_SESSION", sessionId: "sabbath", capacity: 20 };

  it("requires a session for a single-session class and forbids one for all sessions", () => {
    expect(honorOfferingInputSchema.parse(offering)).toMatchObject({ minimumAge: null, perClubLimit: null, isActive: true });
    expect(() => honorOfferingInputSchema.parse({ ...offering, sessionId: null })).toThrow(/Choose the session/);
    expect(() => honorOfferingInputSchema.parse({ ...offering, span: "ALL_SESSIONS" })).toThrow(/isn't tied to one session/);
    expect(honorOfferingInputSchema.parse({ ...offering, span: "ALL_SESSIONS", sessionId: null }).span).toBe("ALL_SESSIONS");
  });

  it("requires whole, non-negative numbers", () => {
    expect(() => honorOfferingInputSchema.parse({ ...offering, capacity: -1 })).toThrow();
    expect(() => honorOfferingInputSchema.parse({ ...offering, minimumAge: 10.5 })).toThrow(/whole number/);
    expect(() => honorOfferingInputSchema.parse({ ...offering, perClubLimit: 0 })).toThrow();
    expect(honorOfferingInputSchema.parse({ ...offering, capacity: 0, minimumAge: 10, perClubLimit: 3 }))
      .toMatchObject({ capacity: 0, minimumAge: 10, perClubLimit: 3 });
  });

  it("never lets an update move a class to another honor or session", () => {
    expect(() => honorOfferingUpdateSchema.parse({ honorId: "birds" })).toThrow();
    expect(() => honorOfferingUpdateSchema.parse({ sessionId: "sunday" })).toThrow();
    expect(honorOfferingUpdateSchema.parse({ capacity: 12, minimumAge: null })).toEqual({ capacity: 12, minimumAge: null });
  });

  it("requires a code and name for catalog honors", () => {
    expect(() => honorInputSchema.parse({ code: " ", name: "Knot Tying" })).toThrow(/code/);
    expect(honorInputSchema.parse({ code: "AR-011", name: "Knot Tying" })).toMatchObject({ description: "", isActive: true });
  });
});
