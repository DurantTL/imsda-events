import { describe, expect, it } from "vitest";
import {
  applicabilityMatches,
  consentPolicyInputSchema,
  consentPolicyPublishInputSchema,
  contentHashFor,
  PolicyKindMismatchError,
  policyApplicabilityInputSchema,
  requirePolicyKind,
  selectEffectiveVersion,
  type PolicyVersionForSelection,
} from "@/modules/consent/domain";

function version(overrides: Partial<PolicyVersionForSelection> & { versionNumber: number }): PolicyVersionForSelection {
  return {
    id: `version-${overrides.versionNumber}`,
    status: "PUBLISHED",
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe("consent policy version selection by date", () => {
  it("selects an open-ended version (no effective-to) at any later date", () => {
    const versions = [version({ versionNumber: 1, effectiveFrom: at("2026-01-01T00:00:00Z") })];
    expect(selectEffectiveVersion(versions, at("2026-01-01T00:00:00Z"))?.id).toBe("version-1");
    expect(selectEffectiveVersion(versions, at("2035-06-01T00:00:00Z"))?.id).toBe("version-1");
    expect(selectEffectiveVersion(versions, at("2025-12-31T23:59:59Z"))).toBeNull();
  });

  it("keeps a republished policy's earlier version effective for dates before the correction", () => {
    const versions = [
      version({ versionNumber: 1, effectiveFrom: at("2026-01-01T00:00:00Z"), effectiveTo: at("2026-06-01T00:00:00Z") }),
      version({ versionNumber: 2, effectiveFrom: at("2026-06-01T00:00:00Z") }),
    ];
    expect(selectEffectiveVersion(versions, at("2026-03-15T00:00:00Z"))?.id).toBe("version-1");
    // Half-open windows: the boundary instant belongs to the successor only.
    expect(selectEffectiveVersion(versions, at("2026-06-01T00:00:00Z"))?.id).toBe("version-2");
    expect(selectEffectiveVersion(versions, at("2027-01-01T00:00:00Z"))?.id).toBe("version-2");
  });

  it("does not select by 'latest' when the newest version is not yet effective", () => {
    const versions = [
      version({ versionNumber: 1, effectiveFrom: at("2026-01-01T00:00:00Z") }),
      version({ versionNumber: 2, effectiveFrom: at("2026-09-01T00:00:00Z") }),
    ];
    expect(selectEffectiveVersion(versions, at("2026-08-31T00:00:00Z"))?.id).toBe("version-1");
    expect(selectEffectiveVersion(versions, at("2026-09-01T00:00:00Z"))?.id).toBe("version-2");
  });

  it("resolves overlapping effective windows to the higher version number", () => {
    const versions = [
      version({ versionNumber: 2, effectiveFrom: at("2026-03-01T00:00:00Z"), effectiveTo: at("2026-12-31T00:00:00Z") }),
      version({ versionNumber: 1, effectiveFrom: at("2026-01-01T00:00:00Z") }),
      version({ versionNumber: 3, effectiveFrom: at("2026-05-01T00:00:00Z"), effectiveTo: at("2026-07-01T00:00:00Z") }),
    ];
    expect(selectEffectiveVersion(versions, at("2026-02-01T00:00:00Z"))?.id).toBe("version-1");
    expect(selectEffectiveVersion(versions, at("2026-04-01T00:00:00Z"))?.id).toBe("version-2");
    expect(selectEffectiveVersion(versions, at("2026-06-01T00:00:00Z"))?.id).toBe("version-3");
    // Version 3 ended; version 2's window still covers this date.
    expect(selectEffectiveVersion(versions, at("2026-08-01T00:00:00Z"))?.id).toBe("version-2");
    // Only the open-ended version 1 remains.
    expect(selectEffectiveVersion(versions, at("2027-02-01T00:00:00Z"))?.id).toBe("version-1");
  });

  it("never selects a draft, even one with dates", () => {
    const versions = [
      version({ versionNumber: 1, effectiveFrom: at("2026-01-01T00:00:00Z") }),
      version({ versionNumber: 2, status: "DRAFT", effectiveFrom: at("2026-01-01T00:00:00Z") }),
    ];
    expect(selectEffectiveVersion(versions, at("2026-02-01T00:00:00Z"))?.id).toBe("version-1");
  });
});

describe("consent policy definitions", () => {
  it("requires scope and event ownership to agree", () => {
    const base = { kind: "WAIVER", slug: "synthetic-waiver", name: "Synthetic waiver" };
    expect(consentPolicyInputSchema.safeParse({ ...base, scope: "EVENT", eventId: "event-1" }).success).toBe(true);
    expect(consentPolicyInputSchema.safeParse({ ...base, scope: "ORGANIZATION", eventId: null }).success).toBe(true);
    expect(consentPolicyInputSchema.safeParse({ ...base, scope: "EVENT", eventId: null }).success).toBe(false);
    expect(consentPolicyInputSchema.safeParse({ ...base, scope: "ORGANIZATION", eventId: "event-1" }).success).toBe(false);
  });

  it("does not let one policy kind stand in for another", () => {
    const waiver = { id: "policy-1", kind: "WAIVER" as const };
    expect(requirePolicyKind(waiver, "WAIVER").id).toBe("policy-1");
    expect(() => requirePolicyKind(waiver, "CONSENT")).toThrow(PolicyKindMismatchError);
    expect(() => requirePolicyKind({ kind: "APPROVAL_REQUIRED" as const }, "ACKNOWLEDGMENT")).toThrow(PolicyKindMismatchError);
  });

  it("rejects an effective window that ends at or before it starts", () => {
    expect(consentPolicyPublishInputSchema.safeParse({
      effectiveFrom: "2026-06-01T00:00:00Z", effectiveTo: "2026-06-01T00:00:00Z", isMaterialChange: true,
    }).success).toBe(false);
    expect(consentPolicyPublishInputSchema.safeParse({ effectiveFrom: "2026-06-01T00:00:00Z" }).success).toBe(false);
    const parsed = consentPolicyPublishInputSchema.parse({ effectiveFrom: "2026-06-01T00:00:00Z", isMaterialChange: false });
    expect(parsed.effectiveTo).toBeNull();
    expect(parsed.isMaterialChange).toBe(false);
  });

  it("hashes title and body without concatenation collisions", () => {
    const one = contentHashFor({ title: "Synthetic a", bodyText: "b c" });
    const two = contentHashFor({ title: "Synthetic a b", bodyText: "c" });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toBe(two);
    expect(contentHashFor({ title: "Synthetic a", bodyText: "b c" })).toBe(one);
  });
});

describe("consent policy applicability", () => {
  const eventDate = at("2026-07-10T00:00:00Z");
  const anyone = { attendeeTypeDefinitionId: null, role: null, minimumAge: null, maximumAge: null };

  it("applies by age band evaluated on the event date, inclusive at both ends", () => {
    const minors = { ...anyone, minimumAge: 0, maximumAge: 17 };
    const turnsEighteenOnEventDay = { attendeeTypeDefinitionId: null, role: null, dateOfBirth: at("2008-07-10T00:00:00Z") };
    const turnsEighteenNextDay = { ...turnsEighteenOnEventDay, dateOfBirth: at("2008-07-11T00:00:00Z") };
    expect(applicabilityMatches(minors, turnsEighteenOnEventDay, eventDate)).toBe(false);
    expect(applicabilityMatches(minors, turnsEighteenNextDay, eventDate)).toBe(true);

    const adults = { ...anyone, minimumAge: 18, maximumAge: null };
    expect(applicabilityMatches(adults, turnsEighteenOnEventDay, eventDate)).toBe(true);
    expect(applicabilityMatches(adults, turnsEighteenNextDay, eventDate)).toBe(false);
  });

  it("does not guess an age band for an attendee with no date of birth", () => {
    const subject = { attendeeTypeDefinitionId: null, role: null, dateOfBirth: null };
    expect(applicabilityMatches({ ...anyone, maximumAge: 17 }, subject, eventDate)).toBe(false);
    expect(applicabilityMatches(anyone, subject, eventDate)).toBe(true);
  });

  it("requires every configured dimension to match", () => {
    const condition = { attendeeTypeDefinitionId: "type-youth", role: "Counselor", minimumAge: 16, maximumAge: null };
    const subject = { attendeeTypeDefinitionId: "type-youth", role: " counselor ", dateOfBirth: at("2009-01-01T00:00:00Z") };
    expect(applicabilityMatches(condition, subject, eventDate)).toBe(true);
    expect(applicabilityMatches(condition, { ...subject, attendeeTypeDefinitionId: "type-adult" }, eventDate)).toBe(false);
    expect(applicabilityMatches(condition, { ...subject, role: "camper" }, eventDate)).toBe(false);
  });

  it("validates configuration input without code changes", () => {
    const parsed = policyApplicabilityInputSchema.parse({ policyId: "policy-1", role: "  ", minimumAge: 0, maximumAge: 17 });
    expect(parsed).toMatchObject({ role: null, isRequired: true, isActive: true, attendeeTypeDefinitionId: null });
    expect(policyApplicabilityInputSchema.safeParse({ policyId: "policy-1", minimumAge: 18, maximumAge: 12 }).success).toBe(false);
  });
});
