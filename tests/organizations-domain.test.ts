import { describe, expect, it } from "vitest";
import {
  normalizeExternalId,
  normalizeOrganizationName,
  normalizeProviderScope,
} from "@/modules/organizations/domain";
import {
  createOrganizationInputSchema,
  externalIdentityInputSchema,
  updateOrganizationInputSchema,
} from "@/modules/organizations/schemas";

describe("organization directory input", () => {
  it("normalizes organization and provider matching keys without changing display names", () => {
    expect(normalizeOrganizationName("  Cedar   Lake CHURCH  ")).toBe(
      "cedar lake church",
    );
    expect(normalizeProviderScope("  Iowa–Missouri   Conference ")).toBe(
      "iowa–missouri conference",
    );
    expect(normalizeExternalId("  ORG-0042 ")).toBe("ORG-0042");
  });

  it("accepts an incomplete club relationship without inventing a church match", () => {
    expect(createOrganizationInputSchema.parse({
      type: "CLUB",
      name: "Pathfinder Club",
      parentOrganizationId: "",
    })).toEqual({
      type: "CLUB",
      name: "Pathfinder Club",
      parentOrganizationId: null,
      isActive: true,
    });
  });

  it("requires optimistic concurrency when an organization is edited", () => {
    expect(() => updateOrganizationInputSchema.parse({
      name: "Cedar Lake",
      parentOrganizationId: null,
      isActive: true,
    })).toThrow();
  });

  it("normalizes provider scope and keeps a provider identifier case-sensitive", () => {
    expect(externalIdentityInputSchema.parse({
      provider: "EADVENTIST",
      providerScope: "  IMSDA Main ",
      externalId: "  AbC-123 ",
      displayLabel: "",
    })).toEqual({
      provider: "EADVENTIST",
      providerScope: "imsda main",
      externalId: "AbC-123",
      displayLabel: null,
    });
  });

  it("rejects unknown organization and provider types", () => {
    expect(() => createOrganizationInputSchema.parse({
      type: "CAMP",
      name: "Camp Heritage",
    })).toThrow();
    expect(() => externalIdentityInputSchema.parse({
      provider: "GOOGLE_SHEETS",
      externalId: "row-1",
    })).toThrow();
  });
});
