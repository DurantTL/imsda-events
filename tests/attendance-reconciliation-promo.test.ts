import { describe, expect, it } from "vitest";
import {
  fingerprintInput,
  reconcileEvent,
  reconcileRegistration,
  reconciliationCsvRows,
  reviewPending,
  pricedGaps,
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

describe("the places of the people who were there when it was priced", () => {
  it("finds the lines of the people who left as the places nobody holds", () => {
    // Priced for three (places 0, 1, 2); the person at place 1 left.
    expect(pricedGaps({ present: [0, 2], leavers: 1 })).toEqual({ ok: true, size: 3, gaps: [1] });
    // Priced for four; the people at places 0 and 3 left.
    expect(pricedGaps({ present: [1, 2], leavers: 2 })).toEqual({ ok: true, size: 4, gaps: [0, 3] });
    // Nobody left: every place is held, listing order does not matter.
    expect(pricedGaps({ present: [2, 0, 1], leavers: 0 })).toEqual({ ok: true, size: 3, gaps: [] });
  });

  it("refuses places that cannot be the priced indexes", () => {
    expect(pricedGaps({ present: [0, 0], leavers: 1 }).ok).toBe(false);
    expect(pricedGaps({ present: [0, 5], leavers: 1 }).ok).toBe(false);
    expect(pricedGaps({ present: [-1, 1], leavers: 1 }).ok).toBe(false);
    expect(pricedGaps({ present: [0, 1], leavers: 0 }).ok).toBe(true);
  });
});

describe("a registration whose prices cannot be matched with certainty", () => {
  const needs = (choice: "PER_PERSON" | "PRORATED" | null, acknowledged: boolean) => registration(2, 4, null, {
    review: { reasons: ["TRANSFER_AFTER_PRICING"], notes: [], acknowledged, acknowledgementId: acknowledged ? "ack-1" : null, choice },
    estimatedCents: 16000,
  });
  const group = (source: RegistrationSource) => ({ key: "g", title: "C", partyKind: "ORGANIZATION" as const, partyId: "o", partyName: "C", clubId: null, registrations: [source] });

  it("shows both figures and bills the prorated one until staff choose", () => {
    const result = reconcileRegistration(needs(null, false));
    expect(result.alternatives).toEqual({ perPersonCents: 10000, proratedCents: 8000 });
    expect(result.basis).toBe("PRORATED_ESTIMATE");
    expect(result.billableCents).toBe(8000);
  });

  it("bills what staff chose, and the choice is part of the fingerprint", () => {
    const perPerson = reconcileRegistration(needs("PER_PERSON", true));
    expect(perPerson.basis).toBe("PER_PERSON_LINES");
    expect(perPerson.billableCents).toBe(10000);
    const prorated = reconcileRegistration(needs("PRORATED", true));
    expect(prorated.billableCents).toBe(8000);
    const base = needs("PER_PERSON", true);
    const choseProrated = { ...base, review: { ...base.review!, choice: "PRORATED" as const } };
    expect(fingerprintInput(reconcileEvent([group(base)], "PER_CHURCH"))).not.toBe(fingerprintInput(reconcileEvent([group(choseProrated)], "PER_CHURCH")));
    // The acknowledgement's own id is not a fact.
    const other = { ...base, review: { ...base.review!, acknowledgementId: "ack-2" } };
    expect(fingerprintInput(reconcileEvent([group(base)], "PER_CHURCH"))).toBe(fingerprintInput(reconcileEvent([group(other)], "PER_CHURCH")));
  });

  it("blocks approval until acknowledged", () => {
    expect(reviewPending(reconcileEvent([group(needs(null, false))], "PER_CHURCH"))).toHaveLength(1);
    expect(reviewPending(reconcileEvent([group(needs("PRORATED", true))], "PER_CHURCH"))).toEqual([]);
  });

  it("does not block approval when nobody attended: there is no figure to confirm", () => {
    const nobody = registration(0, 4, null, { review: { reasons: ["LINE_BEYOND_ROSTER"], notes: [], acknowledged: false, acknowledgementId: null, choice: null }, estimatedCents: 20000 });
    const result = reconcileEvent([group(nobody)], "PER_CHURCH");
    expect(result.groups[0]!.registrations[0]!.billableCents).toBe(0);
    expect(reviewPending(result)).toEqual([]);
  });

  it("lists who was transferred in, in the CSV too", () => {
    const receiver = { ...registration(0, 0, null), people: [person(true), person(true, 5000, { transferredFrom: "Club Sender" })], estimatedCents: 5000 };
    const rows = reconciliationCsvRows(reconcileEvent([group(receiver)], "PER_CHURCH"), { versionLabel: "v", factsChanged: null });
    expect(rows[0]).toContain("Transferred in from");
    expect(rows[1]).toContain("Club Sender");
  });

  it("a person transferred in is shown and billed on the receiving registration", () => {
    const moved = person(true, 5000, { transferredFrom: "Club Sender" });
    const receiver = { ...registration(0, 0, null), people: [person(true), moved], estimatedCents: 5000 };
    const result = reconcileRegistration(receiver);
    expect(result.billableCents).toBe(10000);
    expect(result.people.find((entry) => entry.attendeeId === moved.attendeeId)?.transferredFrom).toBe("Club Sender");
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
