import { describe, expect, it } from "vitest";
import {
  eventNights,
  holdChangeSchema,
  holdCreateSchema,
  nightTotals,
  nightsInclusive,
  projectAvailability,
  quoteStay,
  rateForCategory,
  rateSchema,
  selectPropertySchema,
  sleepsFromBeds,
  stayFit,
  stayNights,
  unitNight,
  unitUpdateSchema,
  type UnitNightState,
} from "@/modules/lodging/domain";

const nights = ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"];

function unit(overrides: Partial<UnitNightState> = {}): UnitNightState {
  return {
    unitId: "u1",
    assignable: true,
    retired: false,
    defaultCapacity: 2,
    capacityOverride: null,
    unavailable: false,
    activeFrom: null,
    activeUntil: null,
    holds: [],
    ...overrides,
  };
}

describe("nights", () => {
  it("lists nights inclusively and a stay without its departure night", () => {
    expect(nightsInclusive("2027-06-30", "2027-07-02")).toEqual(["2027-06-30", "2027-07-01", "2027-07-02"]);
    expect(stayNights("2027-06-15", "2027-06-17")).toEqual(["2027-06-15", "2027-06-16"]);
    expect(stayNights("2027-06-15", "2027-06-15")).toEqual([]);
  });

  it("defaults an event's nights to its first day through the day before its last", () => {
    expect(eventNights({ startDate: "2027-06-15", endDate: "2027-06-19" })).toEqual(nights);
    expect(eventNights({ startDate: "2027-06-15", endDate: "2027-06-19", firstNight: "2027-06-16", lastNight: "2027-06-17" })).toEqual(["2027-06-16", "2027-06-17"]);
  });
});

describe("capacity and availability", () => {
  it("sums what beds sleep: a bunk bed and a double sleep two", () => {
    expect(sleepsFromBeds(["QUEEN", "TWIN_BUNK"])).toBe(4);
    expect(sleepsFromBeds(["TWIN", "TWIN"])).toBe(2);
    expect(sleepsFromBeds([])).toBe(0);
  });

  it("is reproducible: the same inputs give the same projection", () => {
    const states = [unit({ holds: [{ id: "h", firstNight: "2027-06-16", lastNight: "2027-06-16" }] })];
    expect(projectAvailability({ nights, units: states })).toEqual(projectAvailability({ nights, units: states }));
  });

  it("uses an override over the default, and null means no fixed limit", () => {
    expect(unitNight(unit({ capacityOverride: 5 }), nights[0]!).capacity).toBe(5);
    const area = unitNight(unit({ defaultCapacity: null }), nights[0]!);
    expect(area).toMatchObject({ capacity: null, available: null, status: "AVAILABLE" });
  });

  it("takes a closed, held, storage or out-of-dates unit out of service on those nights only", () => {
    expect(unitNight(unit({ unavailable: true }), nights[0]!)).toMatchObject({ status: "UNAVAILABLE", capacity: 0 });
    expect(unitNight(unit({ assignable: false }), nights[0]!).status).toBe("NOT_ASSIGNABLE");
    expect(unitNight(unit({ retired: true }), nights[0]!).status).toBe("NOT_ASSIGNABLE");
    const dated = unit({ activeFrom: "2027-06-16", activeUntil: "2027-06-17" });
    expect(nights.map((night) => unitNight(dated, night).status)).toEqual(["INACTIVE", "AVAILABLE", "AVAILABLE", "INACTIVE"]);
    const held = unit({ holds: [{ id: "h1", firstNight: "2027-06-16", lastNight: "2027-06-17" }] });
    expect(nights.map((night) => unitNight(held, night).status)).toEqual(["AVAILABLE", "HELD", "HELD", "AVAILABLE"]);
    expect(unitNight(held, "2027-06-16").holdIds).toEqual(["h1"]);
  });

  it("checks a partial stay night by night", () => {
    const rows = projectAvailability({ nights, units: [unit({ holds: [{ id: "h", firstNight: "2027-06-16", lastNight: "2027-06-17" }] })] }).get("u1")!;
    expect(stayFit(rows, "2027-06-15", "2027-06-16", 2).fits).toBe(true);
    expect(stayFit(rows, "2027-06-15", "2027-06-18", 2)).toMatchObject({ fits: false, blockedNights: ["2027-06-16", "2027-06-17"] });
    expect(stayFit(rows, "2027-06-18", "2027-06-19", 2).fits).toBe(true);
    // A night outside the event's window, a party too large, and an empty stay never fit.
    expect(stayFit(rows, "2027-06-18", "2027-06-20", 1).fits).toBe(false);
    expect(stayFit(rows, "2027-06-15", "2027-06-16", 3).fits).toBe(false);
    expect(stayFit(rows, "2027-06-15", "2027-06-15", 1).fits).toBe(false);
  });

  it("multi-night capacity counts placed people per night and an area never runs out", () => {
    const occupancy = new Map([["u1", new Map([["2027-06-16", 2]])]]);
    const rows = projectAvailability({ nights, units: [unit()], occupancy }).get("u1")!;
    expect(rows.map((row) => row.available)).toEqual([2, 0, 2, 2]);
    expect(stayFit(rows, "2027-06-15", "2027-06-18", 1).blockedNights).toEqual(["2027-06-16"]);
    const area = projectAvailability({ nights, units: [unit({ unitId: "a", defaultCapacity: null })] }).get("a")!;
    expect(stayFit(area, "2027-06-15", "2027-06-19", 40).fits).toBe(true);
  });

  it("totals the people the inventory takes, noting an unlimited area apart", () => {
    const projection = projectAvailability({ nights, units: [unit(), unit({ unitId: "u2", defaultCapacity: 4 }), unit({ unitId: "u3", unavailable: true }), unit({ unitId: "u4", defaultCapacity: null })] });
    const rows = [...projection.values()].flat();
    expect(nightTotals(rows, "2027-06-15")).toMatchObject({ capacity: 6, unitsInService: 3, unlimited: true });
  });
});

describe("optional rates and quotes", () => {
  const dorm = { amountCents: 2500, basis: "PER_UNIT_NIGHT" as const, minimumNights: 4 };
  const tent = { amountCents: 500, basis: "PER_PERSON_NIGHT" as const, minimumNights: null };

  it("charges nothing when no rate is set: lodging is included or free", () => {
    expect(quoteStay({ rates: {}, category: "DORM_ROOM", nights: 3, partySize: 2 })).toEqual({ kind: "INCLUDED", totalCents: 0 });
  });

  it("prices a dorm room per room per night, whatever the party size", () => {
    expect(quoteStay({ rates: { DORM_ROOM: dorm }, category: "DORM_ROOM", nights: 4, partySize: 1 })).toMatchObject({ kind: "CHARGE", totalCents: 10000 });
    expect(quoteStay({ rates: { DORM_ROOM: dorm }, category: "DORM_ROOM", nights: 5, partySize: 2 })).toMatchObject({ totalCents: 12500 });
    expect(quoteStay({ rates: { DORM_ROOM: dorm }, category: "DORM_ROOM", nights: 4, partySize: 2, units: 2 })).toMatchObject({ totalCents: 20000 });
  });

  it("enforces the minimum nights", () => {
    expect(quoteStay({ rates: { DORM_ROOM: dorm }, category: "DORM_ROOM", nights: 3, partySize: 2 })).toEqual({ kind: "BELOW_MINIMUM_NIGHTS", totalCents: null, minimumNights: 4, nights: 3 });
  });

  it("prices per person per night by the party", () => {
    expect(quoteStay({ rates: { TENT: tent }, category: "TENT", nights: 2, partySize: 3 })).toMatchObject({ totalCents: 3000 });
  });

  it("lets a tent with power share the tent rate unless it has its own", () => {
    expect(rateForCategory({ TENT: tent }, "TENT_WITH_POWER")).toEqual(tent);
    expect(quoteStay({ rates: { TENT: tent }, category: "TENT_WITH_POWER", nights: 1, partySize: 2 }).totalCents).toBe(1000);
    const own = { amountCents: 900, basis: "PER_UNIT_NIGHT" as const, minimumNights: null };
    expect(rateForCategory({ TENT: tent, TENT_WITH_POWER: own }, "TENT_WITH_POWER")).toEqual(own);
    // The fallback is one way: a plain tent never takes the power rate, and nothing else falls back.
    expect(rateForCategory({ TENT_WITH_POWER: own }, "TENT")).toBeNull();
    expect(rateForCategory({ TENT: tent }, "RV_SITE")).toBeNull();
  });

  it("refuses a stay with no nights or no people", () => {
    expect(() => quoteStay({ rates: {}, category: "TENT", nights: 0, partySize: 1 })).toThrow(RangeError);
    expect(() => quoteStay({ rates: {}, category: "TENT", nights: 1, partySize: 0 })).toThrow(RangeError);
  });
});

describe("input schemas", () => {
  it("validates holds", () => {
    expect(holdCreateSchema.safeParse({ kind: "STAFF", reason: "Cooks", firstNight: "2027-06-15", lastNight: "2027-06-18" }).success).toBe(true);
    expect(holdCreateSchema.safeParse({ kind: "STAFF", reason: " ", firstNight: "2027-06-15", lastNight: "2027-06-18" }).success).toBe(false);
    expect(holdCreateSchema.safeParse({ kind: "STAFF", reason: "x", firstNight: "2027-06-18", lastNight: "2027-06-15" }).success).toBe(false);
    expect(holdCreateSchema.safeParse({ kind: "STAFF", reason: "x", firstNight: "2027-02-30", lastNight: "2027-03-01" }).success).toBe(false);
    expect(holdChangeSchema.safeParse({ action: "release", reason: "Done" }).success).toBe(true);
    expect(holdChangeSchema.safeParse({ action: "release" }).success).toBe(false);
  });

  it("validates unit changes, property picks and rates", () => {
    expect(unitUpdateSchema.safeParse({}).success).toBe(false);
    expect(unitUpdateSchema.safeParse({ capacityOverride: -1 }).success).toBe(false);
    expect(unitUpdateSchema.safeParse({ capacityOverride: null }).success).toBe(true);
    expect(selectPropertySchema.safeParse({ propertyKey: "camp-heritage", extra: 1 }).success).toBe(false);
    expect(selectPropertySchema.safeParse({ propertyKey: "camp-heritage", firstNight: "2027-06-18", lastNight: "2027-06-16" }).success).toBe(false);
    expect(selectPropertySchema.safeParse({ propertyKey: "camp-heritage", firstNight: "2027-06-16", lastNight: "2027-06-18" }).success).toBe(true);
    expect(selectPropertySchema.safeParse({ propertyKey: "camp-heritage", firstNight: null, lastNight: null }).success).toBe(true);
    expect(rateSchema.safeParse({ category: "TENT", rate: null }).success).toBe(true);
    expect(rateSchema.safeParse({ category: "TENT", rate: { amountCents: 100.5, basis: "PER_UNIT_NIGHT", minimumNights: null } }).success).toBe(false);
    expect(rateSchema.safeParse({ category: "HOTEL", rate: null }).success).toBe(false);
  });
});
