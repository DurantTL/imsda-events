import { describe, expect, it } from "vitest";
import {
  DUPLICATE_MATCH_RULE_VERSION,
  computeFingerprint,
  computeMatchSignals,
  deriveConfidence,
  evaluatePersonMatch,
  orderPersonPair,
  shouldSurfaceCandidate,
  type PersonMatchContext,
} from "@/modules/people/duplicate-match-domain";

function context(overrides: Partial<PersonMatchContext["person"]> & { id: string }, extra: Partial<Omit<PersonMatchContext, "person">> = {}): PersonMatchContext {
  return {
    person: {
      firstName: "Pat",
      lastName: "Miller",
      normalizedEmail: null,
      phone: null,
      ...overrides,
    },
    activeHouseholdIds: [],
    externalIdentities: [],
    ...extra,
  };
}

describe("computeMatchSignals", () => {
  it("matches on a shared normalized email", () => {
    const a = context({ id: "per_a", normalizedEmail: "avery@example.org" });
    const b = context({ id: "per_b", firstName: "Different", lastName: "Name", normalizedEmail: "avery@example.org" });
    const { matchedSignals, contradictingSignals } = computeMatchSignals(a, b);
    expect(matchedSignals).toContain("EMAIL_MATCH");
    expect(contradictingSignals).not.toContain("EMAIL_MISMATCH");
  });

  it("records a contradicting signal when both have emails that differ", () => {
    const a = context({ id: "per_a", normalizedEmail: "avery@example.org" });
    const b = context({ id: "per_b", normalizedEmail: "someoneelse@example.org" });
    const { matchedSignals, contradictingSignals } = computeMatchSignals(a, b);
    expect(matchedSignals).not.toContain("EMAIL_MATCH");
    expect(contradictingSignals).toContain("EMAIL_MISMATCH");
  });

  it("matches on a shared external identity", () => {
    const identity = { provider: "EADVENTIST", providerScope: "", externalId: "ea-1234" };
    const a = context({ id: "per_a" }, { externalIdentities: [identity] });
    const b = context({ id: "per_b" }, { externalIdentities: [identity] });
    const { matchedSignals } = computeMatchSignals(a, b);
    expect(matchedSignals).toContain("EXTERNAL_IDENTITY_SHARED");
  });

  it("does not treat different external identities as shared", () => {
    const a = context({ id: "per_a" }, { externalIdentities: [{ provider: "EADVENTIST", providerScope: "", externalId: "ea-1" }] });
    const b = context({ id: "per_b" }, { externalIdentities: [{ provider: "EADVENTIST", providerScope: "", externalId: "ea-2" }] });
    const { matchedSignals } = computeMatchSignals(a, b);
    expect(matchedSignals).not.toContain("EXTERNAL_IDENTITY_SHARED");
  });

  it("matches surname and household for twins", () => {
    const a = context({ id: "per_a", firstName: "Ann", lastName: "Twinner" }, { activeHouseholdIds: ["hh_1"] });
    const b = context({ id: "per_b", firstName: "Beth", lastName: "Twinner" }, { activeHouseholdIds: ["hh_1"] });
    const { matchedSignals } = computeMatchSignals(a, b);
    expect(matchedSignals).toEqual(expect.arrayContaining(["SAME_SURNAME", "HOUSEHOLD_SHARED"]));
    expect(matchedSignals).not.toContain("SAME_FULL_NAME");
  });
});

describe("deriveConfidence", () => {
  it("is HIGH for an email match", () => {
    expect(deriveConfidence(["EMAIL_MATCH"])).toBe("HIGH");
  });

  it("is HIGH for a shared external identity", () => {
    expect(deriveConfidence(["EXTERNAL_IDENTITY_SHARED"])).toBe("HIGH");
  });

  it("is MEDIUM for a phone match alone", () => {
    expect(deriveConfidence(["PHONE_MATCH"])).toBe("MEDIUM");
  });

  it("is MEDIUM for a shared surname plus household (twins)", () => {
    expect(deriveConfidence(["SAME_SURNAME", "HOUSEHOLD_SHARED"])).toBe("MEDIUM");
  });

  it("is LOW when nothing strong fired", () => {
    expect(deriveConfidence(["SAME_FULL_NAME"])).toBe("LOW");
    expect(deriveConfidence([])).toBe("LOW");
  });
});

describe("shouldSurfaceCandidate", () => {
  it("does not surface a same-name-only match", () => {
    expect(shouldSurfaceCandidate(["SAME_FULL_NAME", "SAME_SURNAME"])).toBe(false);
  });

  it("surfaces a shared email", () => {
    expect(shouldSurfaceCandidate(["EMAIL_MATCH"])).toBe(true);
  });

  it("surfaces a shared surname plus household", () => {
    expect(shouldSurfaceCandidate(["SAME_SURNAME", "HOUSEHOLD_SHARED"])).toBe(true);
  });

  it("does not surface a household overlap without a shared surname", () => {
    expect(shouldSurfaceCandidate(["HOUSEHOLD_SHARED"])).toBe(false);
  });
});

describe("evaluatePersonMatch", () => {
  it("returns null for two different people who merely share a full name", () => {
    const a = context({ id: "per_a", firstName: "Chris", lastName: "Johnson", normalizedEmail: "chris.j.one@example.org" });
    const b = context({ id: "per_b", firstName: "Chris", lastName: "Johnson", normalizedEmail: "chris.j.two@example.org" });
    expect(evaluatePersonMatch(a, b)).toBeNull();
  });

  it("returns a HIGH-confidence candidate for a shared email", () => {
    const a = context({ id: "per_a", normalizedEmail: "same@example.org" });
    const b = context({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "same@example.org" });
    const evaluation = evaluatePersonMatch(a, b);
    expect(evaluation).not.toBeNull();
    expect(evaluation?.confidence).toBe("HIGH");
    expect(evaluation?.ruleVersion).toBe(DUPLICATE_MATCH_RULE_VERSION);
    expect(evaluation?.fingerprint).toEqual(expect.any(String));
  });

  it("returns a MEDIUM-confidence candidate for twins sharing a household and surname", () => {
    const a = context({ id: "per_a", firstName: "Ann", lastName: "Twinner" }, { activeHouseholdIds: ["hh_1"] });
    const b = context({ id: "per_b", firstName: "Beth", lastName: "Twinner" }, { activeHouseholdIds: ["hh_1"] });
    const evaluation = evaluatePersonMatch(a, b);
    expect(evaluation).not.toBeNull();
    expect(evaluation?.confidence).toBe("MEDIUM");
    expect(evaluation?.matchedSignals).toEqual(expect.arrayContaining(["SAME_SURNAME", "HOUSEHOLD_SHARED"]));
  });

  it("is deterministic: the same inputs always produce the same fingerprint and confidence", () => {
    const a = context({ id: "per_a", normalizedEmail: "same@example.org" });
    const b = context({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "same@example.org" });
    const first = evaluatePersonMatch(a, b);
    const second = evaluatePersonMatch(a, b);
    expect(first).toEqual(second);
  });
});

describe("computeFingerprint", () => {
  it("changes when underlying data changes", () => {
    const base = {
      personA: { id: "per_a", firstName: "Pat", lastName: "Miller", normalizedEmail: "pat@example.org", phone: null },
      personB: { id: "per_b", firstName: "Pat", lastName: "Miller", normalizedEmail: null, phone: null },
      ruleVersion: DUPLICATE_MATCH_RULE_VERSION,
      sharedHouseholdIds: [],
      sharedExternalIdentities: [],
    };
    const before = computeFingerprint(base);
    const after = computeFingerprint({ ...base, personB: { ...base.personB, normalizedEmail: "pat@example.org" } });
    expect(after).not.toBe(before);
  });
});

describe("orderPersonPair", () => {
  it("always orders the pair with the lexicographically smaller id first", () => {
    const x = { id: "per_zzz" };
    const y = { id: "per_aaa" };
    expect(orderPersonPair(x, y)).toEqual([y, x]);
    expect(orderPersonPair(y, x)).toEqual([y, x]);
  });
});
