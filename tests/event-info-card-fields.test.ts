import { describe, expect, it } from "vitest";
import { eventSettingsInputSchema } from "@/modules/events/schemas";
import { honorOfferingInputSchema, honorOfferingUpdateSchema } from "@/modules/honors/schemas";

const settings = {
  name: "Synthetic Weekend",
  slug: "synthetic-weekend",
  startsOn: "2026-11-06",
  endsOn: "2026-11-08",
  timezone: "America/Chicago",
  location: null,
  publicInfoUrl: null,
  supportContact: null,
  collectsShirtSizes: false,
  registrationOpensOn: null,
  registrationClosesOn: null,
  waitlistEnabled: false,
  autoPromoteWaitlist: false,
  capacity: null,
};

describe("event header and help fields (#651)", () => {
  it("leaves absent fields undefined so an update keeps the stored value", () => {
    const parsed = eventSettingsInputSchema.parse(settings);
    expect(parsed.tagline).toBeUndefined();
    expect(parsed.subtitle).toBeUndefined();
    expect(parsed.helpEmail).toBeUndefined();
  });

  it("trims, clears and validates", () => {
    const parsed = eventSettingsInputSchema.parse({ ...settings, tagline: "  Lest We Forget ", subtitle: "", helpEmail: " help@example.test " });
    expect(parsed).toMatchObject({ tagline: "Lest We Forget", subtitle: null, helpEmail: "help@example.test" });
    expect(eventSettingsInputSchema.safeParse({ ...settings, helpEmail: "not an email" }).success).toBe(false);
    expect(eventSettingsInputSchema.safeParse({ ...settings, tagline: "x".repeat(121) }).success).toBe(false);
  });
});

describe("honor offering cost and requirement fields (#651)", () => {
  const offering = { honorId: "honor-1", span: "SINGLE_SESSION" as const, sessionId: "session-1", capacity: 15 };

  it("defaults to no extra cost and no requirement", () => {
    expect(honorOfferingInputSchema.parse(offering)).toMatchObject({ additionalCostCents: null, requirementNote: "" });
  });

  it("accepts a whole-cent cost and a short note, and rejects zero, fractions and long notes", () => {
    expect(honorOfferingInputSchema.parse({ ...offering, additionalCostCents: 500, requirementNote: " Bring a flashlight " }))
      .toMatchObject({ additionalCostCents: 500, requirementNote: "Bring a flashlight" });
    expect(honorOfferingInputSchema.safeParse({ ...offering, additionalCostCents: 0 }).success).toBe(false);
    expect(honorOfferingInputSchema.safeParse({ ...offering, additionalCostCents: 5.5 }).success).toBe(false);
    expect(honorOfferingInputSchema.safeParse({ ...offering, requirementNote: "x".repeat(201) }).success).toBe(false);
  });

  it("a partial update names only what it changes", () => {
    expect(honorOfferingUpdateSchema.parse({ requirementNote: "Closed-toe shoes" })).toEqual({ requirementNote: "Closed-toe shoes" });
    expect(honorOfferingUpdateSchema.parse({ additionalCostCents: null })).toEqual({ additionalCostCents: null });
  });
});
