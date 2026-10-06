import { z } from "zod";

/**
 * Lodging inventory rules (#198, slice 1): pure and free of server-only
 * imports so the service, the screens, the sync script and the tests share one
 * definition. Nights are calendar dates ("YYYY-MM-DD"); a night's date is the
 * evening it starts. No people, preferences or assignments live here (#199/#200).
 */

export const lodgingUnitKinds = ["ROOM", "RV_SITE", "TENT"] as const;
export type LodgingUnitKind = (typeof lodgingUnitKinds)[number];

export const lodgingBedTypes = ["QUEEN", "DOUBLE", "TWIN", "TWIN_BUNK"] as const;
export type LodgingBedType = (typeof lodgingBedTypes)[number];

/** How many people a bed sleeps. A bunk bed is a lower and an upper twin. */
export const bedSleeps: Record<LodgingBedType, number> = { QUEEN: 2, DOUBLE: 2, TWIN: 1, TWIN_BUNK: 2 };

export const lodgingBathrooms = ["PRIVATE", "SHARED", "BATHHOUSE", "UNSPECIFIED"] as const;
export type LodgingBathroom = (typeof lodgingBathrooms)[number];

export const lodgingCategories = ["DORM_ROOM", "CONFERENCE_CENTER_ROOM", "RV_SITE", "TENT_WITH_POWER", "TENT"] as const;
export type LodgingCategory = (typeof lodgingCategories)[number];

export const lodgingCategoryLabels: Record<LodgingCategory, string> = {
  DORM_ROOM: "Dorm room",
  CONFERENCE_CENTER_ROOM: "Conference center room",
  RV_SITE: "RV site",
  TENT_WITH_POWER: "Tent with power",
  TENT: "Tent",
};

/**
 * How a rate is charged. The per-night bases are for Camp Meeting housing; the flat per-event bases are for Man Camp,
 * where the registration price differs by housing choice but not by how many nights are slept.
 */
export const lodgingRateBases = ["PER_UNIT_NIGHT", "PER_PERSON_NIGHT", "PER_UNIT_PER_EVENT", "PER_PERSON_PER_EVENT"] as const;
export type LodgingRateBasis = (typeof lodgingRateBases)[number];

export const lodgingRateBasisLabels: Record<LodgingRateBasis, string> = {
  PER_UNIT_NIGHT: "per room or site per night",
  PER_PERSON_NIGHT: "per person per night",
  PER_UNIT_PER_EVENT: "per room or site for the whole event",
  PER_PERSON_PER_EVENT: "per person for the whole event",
};

/** A rate in words, for the staff screens, the registration form and the private page. */
export function describeRate(rate: { amountCents: number; basis: LodgingRateBasis; minimumNights: number | null }) {
  return `$${(rate.amountCents / 100).toFixed(2)} ${lodgingRateBasisLabels[rate.basis]}${rate.minimumNights ? `, ${rate.minimumNights}+ nights` : ""}`;
}

export const lodgingHoldKinds = ["STAFF", "MAINTENANCE"] as const;
export type LodgingHoldKind = (typeof lodgingHoldKinds)[number];

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

const nightPattern = /^\d{4}-\d{2}-\d{2}$/;

export function isNight(value: string) {
  if (!nightPattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(night: string, days: number) {
  const date = new Date(`${night}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Every night from `first` to `last`, both included. Empty when last is before first. */
export function nightsInclusive(first: string, last: string) {
  const nights: string[] = [];
  for (let night = first; night <= last; night = addDays(night, 1)) nights.push(night);
  return nights;
}

/** The nights of a stay that arrives on `arrival` and leaves on `departure` (the departure night is not slept). */
export function stayNights(arrival: string, departure: string) {
  return departure > arrival ? nightsInclusive(arrival, addDays(departure, -1)) : [];
}

/**
 * The nights an event offers: from the event's first calendar day to the day
 * before its last (the last day is departure), unless staff set a window.
 * `startDate`/`endDate` are calendar days in the event's own time zone.
 */
export function eventNights(input: { startDate: string; endDate: string; firstNight?: string | null; lastNight?: string | null }) {
  const first = input.firstNight ?? input.startDate;
  const last = input.lastNight ?? addDays(input.endDate, -1);
  return nightsInclusive(first, last);
}

export function calendarDay(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

// ---------------------------------------------------------------------------
// Capacity and availability
// ---------------------------------------------------------------------------

export function sleepsFromBeds(beds: readonly LodgingBedType[]) {
  return beds.reduce((total, bed) => total + bedSleeps[bed], 0);
}

export type UnitNightState = {
  unitId: string;
  assignable: boolean;
  /** Retired by a later template version. */
  retired: boolean;
  /** "Sleeps up to"; null is no fixed limit. */
  defaultCapacity: number | null;
  capacityOverride: number | null;
  unavailable: boolean;
  activeFrom: string | null;
  activeUntil: string | null;
  /** Unreleased holds only. */
  holds: ReadonlyArray<{ id: string; firstNight: string; lastNight: string }>;
};

export type NightStatus = "AVAILABLE" | "UNAVAILABLE" | "HELD" | "INACTIVE" | "NOT_ASSIGNABLE";

export type UnitNight = {
  night: string;
  status: NightStatus;
  /** People the unit takes this night; null is no fixed limit. 0 when the unit is out of service. */
  capacity: number | null;
  /** People already placed (none in this slice; #200 supplies it). */
  occupied: number;
  /** Open places this night; null is no fixed limit. */
  available: number | null;
  holdIds: string[];
};

export function effectiveCapacity(unit: Pick<UnitNightState, "defaultCapacity" | "capacityOverride">) {
  return unit.capacityOverride ?? unit.defaultCapacity;
}

/** One unit on one night. Precedence: not assignable or retired, outside its effective dates, unavailable, held. */
export function unitNight(unit: UnitNightState, night: string, occupied = 0): UnitNight {
  const holdIds = unit.holds.filter((hold) => hold.firstNight <= night && night <= hold.lastNight).map((hold) => hold.id);
  let status: NightStatus = "AVAILABLE";
  if (!unit.assignable || unit.retired) status = "NOT_ASSIGNABLE";
  else if ((unit.activeFrom && night < unit.activeFrom) || (unit.activeUntil && night > unit.activeUntil)) status = "INACTIVE";
  else if (unit.unavailable) status = "UNAVAILABLE";
  else if (holdIds.length > 0) status = "HELD";
  const capacity = status === "AVAILABLE" ? effectiveCapacity(unit) : 0;
  return {
    night,
    status,
    capacity,
    occupied,
    available: capacity === null ? null : Math.max(0, capacity - occupied),
    holdIds,
  };
}

/** Deterministic night-by-night projection: the same inputs always give the same answer. */
export function projectAvailability(input: {
  nights: readonly string[];
  units: readonly UnitNightState[];
  /** People placed per unit and night (#200). Absent means none. */
  occupancy?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}) {
  const result = new Map<string, UnitNight[]>();
  for (const unit of input.units) {
    result.set(unit.unitId, input.nights.map((night) => unitNight(unit, night, input.occupancy?.get(unit.unitId)?.get(night) ?? 0)));
  }
  return result;
}

export type StayFit = { fits: boolean; nights: string[]; minimumAvailable: number | null; blockedNights: string[] };

/** Whether `partySize` people fit one unit for every night of a stay; a partial stay is any sub-range of the event's nights. */
export function stayFit(projection: readonly UnitNight[], arrival: string, departure: string, partySize: number): StayFit {
  const wanted = stayNights(arrival, departure);
  const byNight = new Map(projection.map((row) => [row.night, row]));
  const blockedNights: string[] = [];
  let minimumAvailable: number | null = null;
  for (const night of wanted) {
    const row = byNight.get(night);
    if (!row || row.status !== "AVAILABLE" || (row.available !== null && row.available < partySize)) blockedNights.push(night);
    if (row && row.available !== null) minimumAvailable = minimumAvailable === null ? row.available : Math.min(minimumAvailable, row.available);
  }
  return { fits: wanted.length > 0 && blockedNights.length === 0, nights: wanted, minimumAvailable, blockedNights };
}

export type NightTotals = { night: string; capacity: number; occupied: number; available: number; unitsInService: number; unlimited: boolean };

/** Totals for a set of units on one night. An unlimited area adds no number; `unlimited` says one is present. */
export function nightTotals(rows: readonly UnitNight[], night: string): NightTotals {
  const totals: NightTotals = { night, capacity: 0, occupied: 0, available: 0, unitsInService: 0, unlimited: false };
  for (const row of rows) {
    if (row.night !== night || row.status !== "AVAILABLE") continue;
    totals.unitsInService += 1;
    if (row.capacity === null) { totals.unlimited = true; continue; }
    totals.capacity += row.capacity;
    totals.occupied += row.occupied;
    totals.available += row.available ?? 0;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Optional rates and quotes. No rate means lodging is included or free.
// ---------------------------------------------------------------------------

export type LodgingRate = { amountCents: number; basis: LodgingRateBasis; minimumNights: number | null };

/** A tent with power has no rate of its own unless one is set: it shares the tent rate. */
export function rateForCategory(rates: Partial<Record<LodgingCategory, LodgingRate | null>>, category: LodgingCategory): LodgingRate | null {
  const own = rates[category];
  if (own) return own;
  if (category === "TENT_WITH_POWER") return rates.TENT ?? null;
  return null;
}

export type LodgingQuote =
  | { kind: "INCLUDED"; totalCents: 0 }
  | { kind: "CHARGE"; totalCents: number; nights: number; basis: LodgingRateBasis; amountCents: number }
  | { kind: "BELOW_MINIMUM_NIGHTS"; totalCents: null; minimumNights: number; nights: number };

/**
 * What a stay costs. Pure; the registration form and the private page add the charge to the registration total.
 * Per unit per night: amount x nights x units. Per person per night: amount x nights x people.
 * Flat per unit for the event: amount x units. Flat per person for the event: amount x people.
 */
export function quoteStay(input: {
  rates: Partial<Record<LodgingCategory, LodgingRate | null>>;
  category: LodgingCategory;
  nights: number;
  partySize: number;
  units?: number;
}): LodgingQuote {
  if (!Number.isInteger(input.nights) || input.nights < 1) throw new RangeError("A stay needs at least one night.");
  if (!Number.isInteger(input.partySize) || input.partySize < 1) throw new RangeError("A party needs at least one person.");
  const units = input.units ?? 1;
  if (!Number.isInteger(units) || units < 1) throw new RangeError("A stay needs at least one unit.");
  const rate = rateForCategory(input.rates, input.category);
  if (!rate) return { kind: "INCLUDED", totalCents: 0 };
  if (rate.minimumNights !== null && input.nights < rate.minimumNights) {
    return { kind: "BELOW_MINIMUM_NIGHTS", totalCents: null, minimumNights: rate.minimumNights, nights: input.nights };
  }
  const multiplier = rate.basis === "PER_UNIT_NIGHT" || rate.basis === "PER_UNIT_PER_EVENT" ? units : input.partySize;
  // A flat-for-the-event rate does not grow with the nights slept.
  const nightsFactor = rate.basis === "PER_UNIT_NIGHT" || rate.basis === "PER_PERSON_NIGHT" ? input.nights : 1;
  return { kind: "CHARGE", totalCents: rate.amountCents * nightsFactor * multiplier, nights: input.nights, basis: rate.basis, amountCents: rate.amountCents };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const nightSchema = z.string().refine(isNight, "Use a calendar date such as 2027-06-15.");
const reasonSchema = z.string().trim().min(1, "Give a reason.").max(300);

export const selectPropertySchema = z.object({
  propertyKey: z.string().trim().min(1).max(80),
  firstNight: nightSchema.nullish(),
  lastNight: nightSchema.nullish(),
}).strict().refine((value) => !value.firstNight || !value.lastNight || value.lastNight >= value.firstNight, { message: "The last night cannot be before the first night.", path: ["lastNight"] });

export const unitUpdateSchema = z.object({
  /** null clears the override and uses the property default. */
  capacityOverride: z.number().int().min(0).max(500).nullable().optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: z.string().trim().max(300).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Nothing to change.");

export const holdCreateSchema = z.object({
  kind: z.enum(lodgingHoldKinds),
  reason: reasonSchema,
  firstNight: nightSchema,
  lastNight: nightSchema,
}).strict().refine((value) => value.lastNight >= value.firstNight, { message: "The last night cannot be before the first night.", path: ["lastNight"] });

export const holdChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("change_window"),
    firstNight: nightSchema,
    lastNight: nightSchema,
  }).strict().refine((value) => value.lastNight >= value.firstNight, { message: "The last night cannot be before the first night.", path: ["lastNight"] }),
  z.object({ action: z.literal("release"), reason: reasonSchema }).strict(),
]);

export const rateSchema = z.object({
  category: z.enum(lodgingCategories),
  /** null removes the rate: lodging is included or free. */
  rate: z.object({
    amountCents: z.number().int().min(0).max(1_000_000),
    basis: z.enum(lodgingRateBases),
    minimumNights: z.number().int().min(1).max(30).nullable(),
  }).strict().nullable(),
}).strict();
