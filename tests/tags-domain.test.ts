import { describe, expect, it } from "vitest";
import { normalizedTagName, tagInputSchema, tagUpdateSchema } from "@/modules/tags/domain";

describe("tagInputSchema — configured vocabulary, not free text", () => {
  it("requires a 6-digit hex color", () => {
    expect(() => tagInputSchema.parse({ name: "VIP", color: "blue" })).toThrow(/hex code/);
    expect(tagInputSchema.parse({ name: "VIP", color: "#4F46E5" }).color).toBe("#4F46E5");
  });

  it("defaults description and active status", () => {
    const parsed = tagInputSchema.parse({ name: "VIP", color: "#4F46E5" });
    expect(parsed.description).toBe("");
    expect(parsed.isActive).toBe(true);
  });

  it("rejects a name that is too short to be meaningful", () => {
    expect(() => tagInputSchema.parse({ name: "V", color: "#4F46E5" })).toThrow();
  });

  it("update schema accepts deactivating a tag while keeping its identity fields", () => {
    const parsed = tagUpdateSchema.parse({ name: "VIP", color: "#4F46E5", description: "", isActive: false });
    expect(parsed.isActive).toBe(false);
  });
});

describe("normalizedTagName — one spelling per event", () => {
  it("collapses case and surrounding whitespace so near-duplicates collide", () => {
    expect(normalizedTagName("VIP")).toBe(normalizedTagName(" vip "));
    expect(normalizedTagName("Needs Follow-Up")).toBe(normalizedTagName("needs follow-up"));
  });

  it("keeps genuinely different names distinct", () => {
    expect(normalizedTagName("VIP")).not.toBe(normalizedTagName("VIP Plus"));
  });
});
