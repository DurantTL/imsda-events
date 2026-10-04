import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_RULE_VERSION,
  filterResultByLocation,
  fingerprintInput,
  planCorrection,
  reconcileEvent,
  reconcileRegistration,
  reconciliationCsvRows,
  responsibilityBlockers,
  versionFreshness,
  type GroupSource,
  type PersonSource,
  type RegistrationSource,
} from "@/modules/attendance-reconciliation/domain";

/**
 * #166: the pure reconciliation rules. Billable means attended (checked in, adjusted by staff
 * corrections); the #409 rate, late price and meal-sponsorship credit apply to the people who
 * attended. Synthetic data only.
 */

let counter = 0;
function person(overrides: Partial<PersonSource> = {}): PersonSource {
  counter += 1;
  return {
    attendeeId: `att-${counter}`,
    name: `Person ${counter}`,
    checkedIn: false,
    correction: null,
    addedAfterSubmission: false,
    substituted: false,
    chargeCents: 2500,
    lateRate: false,
    adjustmentCents: 0,
    ...overrides,
  };
}

function registration(people: PersonSource[], overrides: Partial<RegistrationSource> = {}): RegistrationSource {
  return {
    registrationId: "reg-1",
    confirmationCode: "CAM-0001",
    status: "CONFIRMED",
    label: "Synthetic Pathfinders",
    clubId: "club-1",
    locationId: null,
    locationName: null,
    estimatedCents: people.reduce((total, entry) => total + entry.chargeCents, 0),
    people,
    registrationChargeCents: 0,
    credits: [],
    registrationAdjustmentCents: 0,
    hasPriceLines: true,
    ...overrides,
  };
}

const correction = (kind: "MARK_ATTENDED" | "MARK_NOT_ATTENDED", reason = "Staff saw them at the gate") => ({
  id: `corr-${kind}-${counter}`,
  kind,
  reason,
  actorName: "Finance Staff",
  createdAt: "2026-10-04T12:00:00.000Z",
});

describe("billable means attended", () => {
  it("bills only people who were checked in; no-shows are counted but not billed", () => {
    const result = reconcileRegistration(registration([
      person({ checkedIn: true }),
      person({ checkedIn: true }),
      person({ checkedIn: false }),
      person({ checkedIn: false }),
    ]));
    expect(result.counts).toEqual({ registered: 4, checkedIn: 2, noShow: 2, addedByStaff: 0, removedByStaff: 0, billable: 2 });
    expect(result.estimatedCents).toBe(10000);
    expect(result.billableCents).toBe(5000);
    expect(result.people.filter((entry) => entry.state === "NO_SHOW")).toHaveLength(2);
  });

  it("bills nothing when nobody attended", () => {
    const result = reconcileRegistration(registration([person(), person()], { registrationChargeCents: 1000 }));
    expect(result.counts.billable).toBe(0);
    expect(result.billableCents).toBe(0);
    expect(result.basis).toBe("NO_ONE_ATTENDED");
  });

  it("a late addition who was checked in is billed at the recorded price, and flagged", () => {
    const late = person({ checkedIn: true, addedAfterSubmission: true, chargeCents: 3500, lateRate: true });
    const result = reconcileRegistration(registration([person({ checkedIn: true }), late]));
    expect(result.counts.registered).toBe(2);
    expect(result.billableCents).toBe(2500 + 3500);
    expect(result.people.find((entry) => entry.attendeeId === late.attendeeId)).toMatchObject({ addedAfterSubmission: true, lateRate: true, billable: true });
  });

  it("a late addition who never came is a no-show like any other", () => {
    const result = reconcileRegistration(registration([person({ checkedIn: true }), person({ addedAfterSubmission: true })]));
    expect(result.counts).toMatchObject({ registered: 2, checkedIn: 1, noShow: 1, billable: 1 });
  });

  it("a substitution counts the replacement, not the person who was swapped out", () => {
    // Roster after the swap: the first person stayed; the second seat now holds the replacement.
    const stayed = person({ checkedIn: true });
    const replacement = person({ checkedIn: true, substituted: true });
    const result = reconcileRegistration(registration([stayed, replacement]));
    expect(result.counts.registered).toBe(2);
    expect(result.counts.billable).toBe(2);
    expect(result.people.find((entry) => entry.attendeeId === replacement.attendeeId)?.substituted).toBe(true);
  });
});

describe("staff corrections", () => {
  it("someone who came but was missed at check-in is added, and shown separately", () => {
    const missed = person({ correction: correction("MARK_ATTENDED") });
    const result = reconcileRegistration(registration([person({ checkedIn: true }), missed]));
    expect(result.counts).toEqual({ registered: 2, checkedIn: 1, noShow: 1, addedByStaff: 1, removedByStaff: 0, billable: 2 });
    expect(result.people.find((entry) => entry.attendeeId === missed.attendeeId)).toMatchObject({ state: "ADDED_BY_STAFF", billable: true });
    expect(result.billableCents).toBe(5000);
  });

  it("a person checked in by mistake is removed, and shown separately", () => {
    const mistaken = person({ checkedIn: true, correction: correction("MARK_NOT_ATTENDED") });
    const result = reconcileRegistration(registration([person({ checkedIn: true }), mistaken]));
    expect(result.counts).toEqual({ registered: 2, checkedIn: 2, noShow: 0, addedByStaff: 0, removedByStaff: 1, billable: 1 });
    expect(result.people.find((entry) => entry.attendeeId === mistaken.attendeeId)).toMatchObject({ state: "REMOVED_BY_STAFF", billable: false });
    expect(result.billableCents).toBe(2500);
  });

  it("the counts always reconcile: billable = checked in + added - removed, no-show = registered - checked in", () => {
    const result = reconcileRegistration(registration([
      person({ checkedIn: true }),
      person({ checkedIn: true, correction: correction("MARK_NOT_ATTENDED") }),
      person({ correction: correction("MARK_ATTENDED") }),
      person(),
    ]));
    const { counts } = result;
    expect(counts.billable).toBe(counts.checkedIn + counts.addedByStaff - counts.removedByStaff);
    expect(counts.noShow).toBe(counts.registered - counts.checkedIn);
  });

  it("refuses a correction that would change nothing, and a withdrawal with nothing to withdraw", () => {
    expect(planCorrection({ checkedIn: true, correction: null }, "MARK_ATTENDED")).toEqual({ ok: false, error: "NO_CHANGE" });
    expect(planCorrection({ checkedIn: false, correction: null }, "MARK_NOT_ATTENDED")).toEqual({ ok: false, error: "NO_CHANGE" });
    expect(planCorrection({ checkedIn: false, correction: null }, "CLEAR")).toEqual({ ok: false, error: "NOTHING_TO_CLEAR" });
    expect(planCorrection({ checkedIn: false, correction: null }, "MARK_ATTENDED")).toEqual({ ok: true });
    expect(planCorrection({ checkedIn: true, correction: null }, "MARK_NOT_ATTENDED")).toEqual({ ok: true });
    // After "marked attended", only the opposite or a withdrawal changes anything.
    expect(planCorrection({ checkedIn: false, correction: correction("MARK_ATTENDED") }, "MARK_ATTENDED")).toEqual({ ok: false, error: "NO_CHANGE" });
    expect(planCorrection({ checkedIn: false, correction: correction("MARK_ATTENDED") }, "CLEAR")).toEqual({ ok: true });
    expect(planCorrection({ checkedIn: false, correction: correction("MARK_ATTENDED") }, "MARK_NOT_ATTENDED")).toEqual({ ok: true });
  });
});

describe("#409 amounts applied to attended people", () => {
  const credit = { key: "meal_sponsorship_count", label: "Meal sponsorship credit", centsPerUnit: -500, rawUnits: 6, capAtHeadcount: true, recordedCents: -2500 };

  it("caps the meal-sponsorship credit at the people who attended, not the people registered", () => {
    const people = [person({ checkedIn: true }), person({ checkedIn: true }), person(), person(), person()];
    const result = reconcileRegistration(registration(people, { credits: [credit] }));
    // 5 registered: the estimate would credit min(6, 5) = 5 people. 2 attended: the credit is 2 people.
    expect(result.credits).toEqual([{ label: "Meal sponsorship credit", units: 2, appliedCents: -1000 }]);
    expect(result.billableCents).toBe(5000 - 1000);
  });

  it("never lets the credit take the charges below $0", () => {
    const result = reconcileRegistration(registration([person({ checkedIn: true, chargeCents: 300 })], { credits: [credit] }));
    expect(result.billableCents).toBe(0);
    expect(result.components.creditCents).toBe(-300);
  });

  it("keeps a credit it cannot recompute as recorded", () => {
    const result = reconcileRegistration(registration([person({ checkedIn: true })], {
      credits: [{ key: "x", label: "Credit", centsPerUnit: null, rawUnits: null, capAtHeadcount: false, recordedCents: -500 }],
    }));
    expect(result.billableCents).toBe(2000);
  });

  it("applies the late rate only to the people it was recorded for", () => {
    const result = reconcileRegistration(registration([
      person({ checkedIn: true, chargeCents: 1400, lateRate: true }),
      person({ checkedIn: true, chargeCents: 900 }),
      person({ chargeCents: 1400, lateRate: true }),
    ]));
    expect(result.billableCents).toBe(2300);
  });

  it("keeps a registration-level fee whole while anyone attended, and drops it when nobody did", () => {
    const withFee = (attended: boolean) => reconcileRegistration(registration([person({ checkedIn: attended }), person({ checkedIn: attended })], { registrationChargeCents: 2000 }));
    expect(withFee(true).billableCents).toBe(5000 + 2000);
    expect(withFee(false).billableCents).toBe(0);
  });

  it("counts staff adjustments for the registration and for people who attended only", () => {
    const attended = person({ checkedIn: true, adjustmentCents: -500 });
    const absent = person({ adjustmentCents: -500 });
    const result = reconcileRegistration(registration([attended, absent], { registrationAdjustmentCents: -100 }));
    expect(result.billableCents).toBe(2500 - 500 - 100);
  });

  it("prorates the estimate when there are no price lines, and says so", () => {
    const result = reconcileRegistration(registration([person({ checkedIn: true, chargeCents: 0 }), person({ chargeCents: 0 })], { hasPriceLines: false, estimatedCents: 5001 }));
    expect(result.basis).toBe("PRORATED_ESTIMATE");
    expect(result.billableCents).toBe(2500);
  });
});

describe("grouping, fingerprint, location filter", () => {
  const groupOf = (key: string, registrations: RegistrationSource[]): GroupSource => ({
    key, title: key, partyKind: "ORGANIZATION", partyId: key, partyName: key, clubId: null, registrations,
  });

  it("sums registrations into groups and the event, keeping estimated and billable apart", () => {
    const result = reconcileEvent([
      groupOf("church-a", [registration([person({ checkedIn: true }), person()], { registrationId: "r1" }), registration([person({ checkedIn: true })], { registrationId: "r2" })]),
      groupOf("church-b", [registration([person()], { registrationId: "r3" })]),
    ], "PER_CHURCH");
    expect(result.groups[0]?.counts).toMatchObject({ registered: 3, checkedIn: 2, noShow: 1, billable: 2 });
    expect(result.groups[0]).toMatchObject({ estimatedCents: 7500, billableCents: 5000 });
    expect(result.totals).toMatchObject({ registered: 4, checkedIn: 2, billable: 2, estimatedCents: 10000, billableCents: 5000 });
    expect(result.ruleVersion).toBe(RECONCILIATION_RULE_VERSION);
  });

  it("the same facts give the same fingerprint input; a changed fact or rule changes it", () => {
    const build = (checkedIn: boolean, actorName = "A", createdAt = "t1") => {
      const entry = person({ attendeeId: "fixed", name: "Fixed", checkedIn, correction: { id: "c1", kind: "MARK_ATTENDED", reason: "r", actorName, createdAt } });
      return reconcileEvent([groupOf("g", [registration([entry])])], "PER_CHURCH");
    };
    expect(fingerprintInput(build(false))).toBe(fingerprintInput(build(false, "B", "t2")));
    expect(fingerprintInput(build(false))).not.toBe(fingerprintInput(build(true)));
    expect(fingerprintInput({ ...build(false), ruleVersion: "attended-v2" })).not.toBe(fingerprintInput(build(false)));
  });

  it("filters a view by location and recomputes group and event figures", () => {
    const result = reconcileEvent([
      groupOf("g", [
        registration([person({ checkedIn: true })], { registrationId: "r1", locationId: "loc-a" }),
        registration([person({ checkedIn: true })], { registrationId: "r2", locationId: "loc-b" }),
      ]),
    ], "PER_CHURCH");
    const filtered = filterResultByLocation(result, "loc-a");
    expect(filtered.groups[0]?.registrations.map((entry) => entry.registrationId)).toEqual(["r1"]);
    expect(filtered.totals.billable).toBe(1);
    expect(filterResultByLocation(result, "loc-none").groups).toEqual([]);
    expect(filterResultByLocation(result, null)).toBe(result);
  });
});

describe("responsibility gate (#165)", () => {
  const line = (overrides: Partial<Parameters<typeof responsibilityBlockers>[0][number]> = {}) => ({
    registrationId: "r", confirmationCode: "C-1", label: "Club", status: "CONFIRMED" as const, recorded: true, outdated: false, unresolved: false, ...overrides,
  });

  it("blocks on unrecorded, out-of-date and unresolved billed registrations", () => {
    const blockers = responsibilityBlockers([
      line({ registrationId: "a", recorded: false }),
      line({ registrationId: "b", outdated: true }),
      line({ registrationId: "c", unresolved: true }),
      line({ registrationId: "d" }),
    ]);
    expect(blockers.map((entry) => [entry.registrationId, entry.reason])).toEqual([["a", "UNRECORDED"], ["b", "OUTDATED"], ["c", "UNRESOLVED"]]);
  });

  it("does not block on registrations that owe nothing", () => {
    expect(responsibilityBlockers([line({ status: "CANCELLED", unresolved: true }), line({ status: "WAITLISTED", recorded: false })])).toEqual([]);
  });
});

describe("version freshness", () => {
  it("flags an approved version whose facts have since changed, without altering it", () => {
    expect(versionFreshness({ status: "APPROVED", fingerprint: "a" }, "a")).toBe("CURRENT");
    expect(versionFreshness({ status: "APPROVED", fingerprint: "a" }, "b")).toBe("FACTS_CHANGED");
    expect(versionFreshness({ status: "SUPERSEDED", fingerprint: "a" }, "b")).toBe("SUPERSEDED");
  });
});

describe("CSV", () => {
  it("has one row per registration, no attendee names, and is formula-safe via the shared writer", () => {
    const result = reconcileEvent([{
      key: "g", title: "=HYPERLINK(\"x\")", partyKind: "ORGANIZATION", partyId: "o", partyName: "Church", clubId: null,
      registrations: [registration([person({ name: "Someone Private", checkedIn: true })])],
    }], "PER_CHURCH");
    const rows = reconciliationCsvRows(result, { versionLabel: "Version 1 (approved)", factsChanged: true });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("25.00");
    expect(rows[1]).toContain("Yes");
    expect(JSON.stringify(rows)).not.toContain("Someone Private");
    expect(rows[0]).toContain("Estimated (registered)");
  });
});
