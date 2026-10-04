import { describe, expect, it } from "vitest";
import {
  fingerprintInput,
  reconcileEvent,
  reconcileRegistration,
  reconciliationCsvRows,
  reviewPending,
  rosterMismatchReasons,
  type PersonSource,
  type PromoSource,
  type RegistrationSource,
} from "@/modules/attendance-reconciliation/domain";

/**
 * #166 review follow-up: whole-registration promo codes, roster review after a member transfer,
 * charges not tied to a person, and what a saved version and its fingerprint may hold.
 * Synthetic data only.
 */

let counter = 0;
const person = (checkedIn: boolean, chargeCents = 5000, extras: Partial<PersonSource> = {}): PersonSource => {
  counter += 1;
  return { attendeeId: `p-${counter}`, name: `Person ${counter}`, checkedIn, correction: null, addedAfterSubmission: false, substituted: false, chargeCents, lateRate: false, adjustmentCents: 0, ...extras };
};

function registration(attended: number, registered: number, promo: PromoSource | null, extras: Partial<RegistrationSource> = {}): RegistrationSource {
  const people = Array.from({ length: registered }, (_, index) => person(index < attended));
  // The discount the estimate recorded, as the pricing engine limits it to the registered subtotal.
  const gross = registered * 5000;
  const recorded = !promo ? 0 : promo.type === "PERCENT_BPS"
    ? Math.min(Math.floor((gross * promo.value) / 10_000), promo.maximumDiscountCents ?? gross)
    : Math.min(promo.value, gross);
  return {
    registrationId: "r1", confirmationCode: "C-1", status: "CONFIRMED", label: "Synthetic Club", clubId: "c", locationId: null, locationName: null,
    estimatedCents: gross - recorded,
    people, registrationCharges: [], credits: [], promo: promo && { ...promo, recordedCents: recorded }, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
    ...extras,
  };
}

const fixed: PromoSource = { code: "SAVE100", type: "FIXED_CENTS", value: 10000, maximumDiscountCents: null, recordedCents: 10000 };
const percent: PromoSource = { code: "TEN", type: "PERCENT_BPS", value: 1000, maximumDiscountCents: null, recordedCents: 5000 };

describe("whole-registration promo codes", () => {
  it("a fixed code is applied in full when everyone attends: 10 x $50 with $100 off is $400, not $500", () => {
    const result = reconcileRegistration(registration(10, 10, fixed));
    expect(result.estimatedCents).toBe(40000);
    expect(result.billableCents).toBe(40000);
    expect(result.promo).toEqual({ code: "SAVE100", appliedCents: -10000 });
    expect(result.components.promoCents).toBe(-10000);
  });

  it("a fixed code is applied in full to partial attendance, capped at what the attended people owe", () => {
    expect(reconcileRegistration(registration(6, 10, fixed)).billableCents).toBe(30000 - 10000);
    // Two attended owe $100: the $100 code takes it to $0, never below.
    expect(reconcileRegistration(registration(2, 10, fixed)).billableCents).toBe(0);
    expect(reconcileRegistration(registration(1, 10, fixed)).billableCents).toBe(0);
  });

  it("a percentage code gives the same percentage of what the attended people owe", () => {
    // 10 x $50 = $500, 10% = $50 off the estimate: $450.
    const everyone = reconcileRegistration(registration(10, 10, percent));
    expect(everyone.estimatedCents).toBe(45000);
    expect(everyone.billableCents).toBe(45000);
    // 6 attended: $300 less 10% = $270.
    expect(reconcileRegistration(registration(6, 10, percent)).billableCents).toBe(27000);
  });

  it("honours a percentage code's maximum discount", () => {
    const capped: PromoSource = { ...percent, maximumDiscountCents: 2000, recordedCents: 2000 };
    expect(reconcileRegistration(registration(10, 10, capped)).billableCents).toBe(48000);
  });

  it("never bills more than the estimate when everyone attends, and never below $0", () => {
    for (const promo of [fixed, percent, null]) {
      for (const registered of [1, 3, 10]) {
        const result = reconcileRegistration(registration(registered, registered, promo));
        expect(result.billableCents).toBeLessThanOrEqual(result.estimatedCents);
        expect(result.billableCents).toBeGreaterThanOrEqual(0);
        for (let attended = 0; attended <= registered; attended += 1) {
          const partial = reconcileRegistration(registration(attended, registered, promo));
          expect(partial.billableCents).toBeGreaterThanOrEqual(0);
          expect(partial.billableCents).toBeLessThanOrEqual(result.billableCents);
        }
      }
    }
  });

  it("applies after the meal credit, the way the estimate does, and a code never exceeds what was recorded", () => {
    const credit = { key: "meal", label: "Meal credit", centsPerUnit: -500, rawUnits: 4, capAtHeadcount: true, recordedCents: -2000 };
    const everyone = reconcileRegistration(registration(4, 4, percent, { credits: [credit], estimatedCents: 20000 - 2000 - 1800 }));
    // 4 x $50 = $200, credit -$20 = $180, 10% = $18 off -> $162. The recorded discount ($50) is only a ceiling.
    expect(everyone.components.promoCents).toBe(-1800);
    expect(everyone.billableCents).toBe(16200);
  });

  it("is its own line in the result, and in the CSV", () => {
    const result = reconcileEvent([{ key: "g", title: "Church", partyKind: "ORGANIZATION", partyId: "o", partyName: "Church", clubId: null, registrations: [registration(10, 10, fixed)] }], "PER_CHURCH");
    expect(result.groups[0]!.registrations[0]!.promo).toEqual({ code: "SAVE100", appliedCents: -10000 });
    const rows = reconciliationCsvRows(result, { versionLabel: "v", factsChanged: null });
    expect(rows[0]).toContain("Whole-registration promo code");
    expect(rows[1]).toContain("-100.00");
  });

  it("per-person promo codes are adjustment rows and are not counted twice", () => {
    const own = person(true, 5000, { adjustmentCents: -1000 });
    const result = reconcileRegistration({ ...registration(0, 0, null), people: [own, person(true)], estimatedCents: 9000 });
    expect(result.billableCents).toBe(9000);
    expect(result.promo).toBeNull();
  });
});

describe("charges not tied to a person", () => {
  it("lists registration-level charges and credits it cannot recompute, kept whole", () => {
    const result = reconcileRegistration(registration(1, 4, null, {
      registrationCharges: [{ label: "Flat registration fee", cents: 2000 }],
      credits: [{ key: "x", label: "Old credit", centsPerUnit: null, rawUnits: null, capAtHeadcount: false, recordedCents: -500 }],
    }));
    expect(result.unattached).toEqual([
      { label: "Flat registration fee", amountCents: 2000, kind: "CHARGE" },
      { label: "Old credit", amountCents: -500, kind: "CREDIT_AS_RECORDED" },
    ]);
    expect(result.billableCents).toBe(5000 + 2000 - 500);
    const rows = reconciliationCsvRows(reconcileEvent([{ key: "g", title: "C", partyKind: "ORGANIZATION", partyId: "o", partyName: "C", clubId: null, registrations: [registration(1, 4, null, { registrationCharges: [{ label: "Flat", cents: 2000 }] })] }], "PER_CHURCH"), { versionLabel: "v", factsChanged: null });
    expect(rows[0]).toContain("Charges not tied to a person");
    expect(rows[1]).toContain("20.00");
  });

  it("a per-unit credit it can recompute shrinks with attendance and is not listed", () => {
    const result = reconcileRegistration(registration(2, 4, null, { credits: [{ key: "m", label: "Meal credit", centsPerUnit: -500, rawUnits: 4, capAtHeadcount: true, recordedCents: -2000 }] }));
    expect(result.unattached).toEqual([]);
    expect(result.components.creditCents).toBe(-1000);
  });
});

describe("roster review after a member transfer", () => {
  const lines = (labels: Array<string | null>) => labels.map((attendeeLabel, attendeeIndex) => ({ attendeeIndex, attendeeLabel }));
  const roster = (...names: string[]) => names.map((name) => ({ name, substituted: false }));

  it("trusts prices whose names still line up", () => {
    expect(rosterMismatchReasons({ priceLines: lines(["Ann Verify", "Verify, Bo"]), attendees: roster("Ann Verify", "Bo Verify"), transfersAfterPricing: 0 })).toEqual([]);
    expect(rosterMismatchReasons({ priceLines: lines(["Person 1", null]), attendees: roster("Ann Verify", "Bo Verify"), transfersAfterPricing: 0 })).toEqual([]);
  });

  it("flags a price line past the roster, a name that is not at that place, and a transfer after pricing", () => {
    expect(rosterMismatchReasons({ priceLines: lines(["A", "B", "C"]).map((line) => ({ ...line, attendeeLabel: null })), attendees: roster("A", "B"), transfersAfterPricing: 0 })).toEqual(["LINE_BEYOND_ROSTER"]);
    expect(rosterMismatchReasons({ priceLines: lines(["Ann Verify", "Cy Verify"]), attendees: roster("Ann Verify", "Bo Verify"), transfersAfterPricing: 0 })).toEqual(["NAME_MISMATCH"]);
    expect(rosterMismatchReasons({ priceLines: lines([null]), attendees: roster("Ann Verify"), transfersAfterPricing: 1 })).toEqual(["TRANSFER_AFTER_PRICING"]);
  });

  it("does not compare the name of a seat whose person was substituted, which keeps its price", () => {
    expect(rosterMismatchReasons({ priceLines: lines(["Ann Verify"]), attendees: [{ name: "New Person", substituted: true }], transfersAfterPricing: 0 })).toEqual([]);
  });

  it("bills a registration needing review on its prorated estimate and holds approval until acknowledged", () => {
    const needs = registration(2, 4, null, { review: { reasons: ["TRANSFER_AFTER_PRICING"], acknowledged: false, acknowledgementId: null }, estimatedCents: 20000 });
    const result = reconcileRegistration(needs);
    expect(result.basis).toBe("PRORATED_ESTIMATE");
    expect(result.billableCents).toBe(10000);
    const event = reconcileEvent([{ key: "g", title: "C", partyKind: "ORGANIZATION", partyId: "o", partyName: "C", clubId: null, registrations: [needs] }], "PER_CHURCH");
    expect(reviewPending(event)).toHaveLength(1);
    const acknowledged = reconcileEvent([{ key: "g", title: "C", partyKind: "ORGANIZATION", partyId: "o", partyName: "C", clubId: null, registrations: [{ ...needs, review: { reasons: ["TRANSFER_AFTER_PRICING"], acknowledged: true, acknowledgementId: "ack-1" } }] }], "PER_CHURCH");
    expect(reviewPending(acknowledged)).toEqual([]);
    expect(fingerprintInput(acknowledged)).not.toBe(fingerprintInput(event));
  });
});

describe("what a version and its fingerprint hold", () => {
  it("holds a correction's id, kind and attendee only: no reason text, actor or time", () => {
    const corrected = person(false, 5000, { correction: { id: "corr-1", kind: "MARK_ATTENDED" } });
    const event = reconcileEvent([{ key: "g", title: "C", partyKind: "ORGANIZATION", partyId: "o", partyName: "C", clubId: null, registrations: [{ ...registration(0, 0, null), people: [corrected], estimatedCents: 5000 }] }], "PER_CHURCH");
    const stored = JSON.stringify(event);
    expect(stored).toContain("corr-1");
    expect(stored).not.toMatch(/reason|actorName|createdAt/i);
  });

  it("a re-entered identical correction (a new row, the same kind) gives the same fingerprint", () => {
    const build = (correctionId: string) => reconcileEvent([{ key: "g", title: "C", partyKind: "ORGANIZATION", partyId: "o", partyName: "C", clubId: null, registrations: [{
      ...registration(0, 0, null),
      people: [{ ...person(false, 5000), attendeeId: "fixed", name: "Fixed", correction: { id: correctionId, kind: "MARK_ATTENDED" } }],
      estimatedCents: 5000,
    }] }], "PER_CHURCH");
    expect(fingerprintInput(build("corr-1"))).toBe(fingerprintInput(build("corr-2")));
  });
});
