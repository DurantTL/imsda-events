import { z } from "zod";
import {
  calendarDay,
  isNight,
  lodgingCategories,
  lodgingCategoryLabels,
  nightsInclusive,
  type LodgingCategory,
} from "@/modules/lodging/domain";

/**
 * Lodging preferences, roommate requests and household rules (#199, slice 2): pure rules shared by the
 * service, the screens and the tests. Nothing here assigns anyone to a unit (that is #200).
 *
 * Privacy rules this file enforces by shape:
 * - Accessibility is two yes/no flags. No schema below accepts free text for it, and every schema is
 *   strict, so a field such as "medicalReason" is refused rather than ignored.
 * - A roommate request names a registration (and optionally a person on it). Nothing here carries an
 *   email, phone or address, and a registrant-facing result never says who asked for them.
 */

export const lodgingRequestSources = ["REGISTRANT", "STAFF", "REGISTRATION_FORM"] as const;
export type LodgingRequestSource = (typeof lodgingRequestSources)[number];

export const householdPreferences = ["TOGETHER", "FLEXIBLE"] as const;
export type HouseholdPreference = (typeof householdPreferences)[number];

export const fullBehaviors = ["SHOW_FULL", "WAITLIST"] as const;
export type FullBehavior = (typeof fullBehaviors)[number];

export const roommateDecisions = ["PENDING", "APPROVED", "DECLINED"] as const;
export type RoommateDecision = (typeof roommateDecisions)[number];

export const lodgingRuleKinds = ["KEEP_TOGETHER", "SPLIT_HOUSEHOLD", "SEPARATE"] as const;
export type LodgingRuleKind = (typeof lodgingRuleKinds)[number];

export const lodgingRuleKindLabels: Record<LodgingRuleKind, string> = {
  KEEP_TOGETHER: "Keep together",
  SPLIT_HOUSEHOLD: "Split from household",
  SEPARATE: "Keep apart",
};

/** The registrations whose lodging request counts: a draft or a cancellation is not on the roster. */
export const lodgingActiveRegistrationStatuses = ["SUBMITTED", "CONFIRMED"] as const;

// ---------------------------------------------------------------------------
// Input schemas (all strict)
// ---------------------------------------------------------------------------

const nightSchema = z.string().refine(isNight, "Use a calendar date such as 2027-06-15.");
const reasonSchema = z.string().trim().min(1, "Give a reason.").max(300);
const idSchema = z.string().trim().min(1).max(100);

const requestShape = {
  /** null means "no preference": the guest is not asking for a category. */
  category: z.enum(lodgingCategories).nullable(),
  firstNight: nightSchema.nullish(),
  lastNight: nightSchema.nullish(),
  partySize: z.number().int().min(1).max(100).optional(),
  /** Rooms the registrant wants (room-type categories only; a site or a tent is one unit). Defaults to 1 (#803). */
  roomCount: z.number().int().min(1).max(100).optional(),
  /** The registrant saw that the party is larger than the beds in the chosen rooms and will bring extra bedding (#803). */
  bringsExtraBedding: z.boolean().optional(),
  groundFloorNeeded: z.boolean().optional(),
  accessibleRoomNeeded: z.boolean().optional(),
  privateRoomRequested: z.boolean().optional(),
  householdPreference: z.enum(householdPreferences).optional(),
};

function nightsRefinement(value: { firstNight?: string | null; lastNight?: string | null }, ctx: z.RefinementCtx) {
  const first = value.firstNight ?? null;
  const last = value.lastNight ?? null;
  if ((first === null) !== (last === null)) {
    ctx.addIssue({ code: "custom", message: "Give both the first and the last night, or neither.", path: ["lastNight"] });
  } else if (first !== null && last !== null && last < first) {
    ctx.addIssue({ code: "custom", message: "The last night cannot be before the first night.", path: ["lastNight"] });
  }
}

/** What a registrant may change. No free-text field exists, by design. */
export const lodgingRequestSchema = z.object(requestShape).strict().superRefine(nightsRefinement);
export type LodgingRequestInput = z.infer<typeof lodgingRequestSchema>;

/**
 * The lodging step of the public registration form (#199): the same fields a registrant can later change on the
 * private page, plus roommate requests, made before the registration exists. A roommate on another registration is
 * named by name and confirmation code together; one on this registration is named by the attendee rows' client ids.
 */
export const registrationLodgingSchema = z.object({
  ...requestShape,
  roommates: z.array(z.object({
    name: z.string().trim().min(1, "Enter the name.").max(120),
    confirmationCode: z.string().trim().min(4, "Enter the confirmation code.").max(40),
    /** The attendee row (client id) asking; omitted means the whole registration. */
    fromClientId: z.string().trim().min(1).max(80).optional(),
  }).strict()).max(5).optional(),
  roommatesWithin: z.array(z.object({
    fromClientId: z.string().trim().min(1).max(80),
    targetClientId: z.string().trim().min(1).max(80),
  }).strict()).max(10).optional(),
}).strict().superRefine(nightsRefinement);
export type RegistrationLodgingInput = z.infer<typeof registrationLodgingSchema>;

/** A staff edit carries the reason it was made (and is the only way to change a request after the deadline). */
export const staffLodgingRequestSchema = z.object({ ...requestShape, reason: reasonSchema }).strict().superRefine(nightsRefinement);

export const lodgingSettingsSchema = z.object({
  collectsPreferences: z.boolean().optional(),
  /** null follows the event's registration close date. */
  preferencesDeadline: nightSchema.nullable().optional(),
  fullBehavior: z.enum(fullBehaviors).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Nothing to change.");

export const registrantRoommateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_by_code"),
    name: z.string().trim().min(1, "Enter the name.").max(120),
    confirmationCode: z.string().trim().min(4, "Enter the confirmation code.").max(40),
    /** Which person on your registration is asking; omitted means the whole registration. */
    fromPersonId: idSchema.optional(),
  }).strict(),
  z.object({ action: z.literal("add_in_registration"), fromPersonId: idSchema, targetPersonId: idSchema }).strict(),
  z.object({ action: z.literal("withdraw"), requestId: idSchema }).strict(),
]);

export const staffRoommateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), requestId: idSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("decline"), requestId: idSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("withdraw"), requestId: idSchema, reason: reasonSchema }).strict(),
]);

export const ruleCreateSchema = z.object({
  kind: z.enum(lodgingRuleKinds),
  personAId: idSchema,
  personBId: idSchema.nullish(),
  reason: reasonSchema,
  effectiveFrom: nightSchema.nullish(),
  effectiveUntil: nightSchema.nullish(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "SPLIT_HOUSEHOLD") {
    if (value.personBId) ctx.addIssue({ code: "custom", message: "A split names one person.", path: ["personBId"] });
  } else if (!value.personBId) {
    ctx.addIssue({ code: "custom", message: "Name the second person.", path: ["personBId"] });
  } else if (value.personBId === value.personAId) {
    ctx.addIssue({ code: "custom", message: "Name two different people.", path: ["personBId"] });
  }
  if (value.effectiveFrom && value.effectiveUntil && value.effectiveUntil < value.effectiveFrom) {
    ctx.addIssue({ code: "custom", message: "The last night cannot be before the first night.", path: ["effectiveUntil"] });
  }
});

export const ruleActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), rule: ruleCreateSchema }).strict(),
  z.object({ action: z.literal("end"), ruleId: idSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("acknowledge"), itemKey: z.string().trim().min(1).max(300), fingerprint: z.string().trim().min(1).max(300), note: reasonSchema }).strict(),
]);

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

/**
 * The last day a registrant may change a preference (inclusive, in the event's time zone): the event's own
 * lodging deadline, else its registration close date, else the day before the event starts.
 */
export function lodgingDeadlineDay(input: { preferencesDeadline: string | null; registrationClosesOn: string | null; eventStartDay: string }) {
  const closes = input.registrationClosesOn && isNight(input.registrationClosesOn) ? input.registrationClosesOn : null;
  return input.preferencesDeadline ?? closes ?? input.eventStartDay;
}

export function isPastLodgingDeadline(deadlineDay: string, now: Date, timeZone: string) {
  return calendarDay(now, timeZone) > deadlineDay;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Case, accents and spacing do not matter when a registrant types a name they were told. */
export function normalizeName(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function normalizeConfirmationCode(value: string) {
  return value.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Roommate requests: directional until both sides ask, or staff approve
// ---------------------------------------------------------------------------

export type RoommateRow = {
  id: string;
  fromRegistrationId: string;
  targetRegistrationId: string;
  fromPersonId: string | null;
  targetPersonId: string | null;
  decision: RoommateDecision;
  withdrawn: boolean;
};

export type RoommateStatus =
  | { status: "MUTUAL"; basis: "BOTH_ASKED" | "STAFF_APPROVED" | "SAME_REGISTRATION" }
  | { status: "ONE_SIDED" }
  | { status: "DECLINED" }
  | { status: "WITHDRAWN" };

const compatible = (a: string | null, b: string | null) => a === null || b === null || a === b;

/** Whether `other` is the same people asking back: from and target swapped, and any named people agree. */
export function isReciprocal(row: RoommateRow, other: RoommateRow) {
  return other.id !== row.id
    && other.fromRegistrationId === row.targetRegistrationId
    && other.targetRegistrationId === row.fromRegistrationId
    && compatible(row.fromPersonId, other.targetPersonId)
    && compatible(row.targetPersonId, other.fromPersonId);
}

/**
 * One request's standing. A decline by staff ends it. An approval by staff makes it mutual. Otherwise it is
 * mutual only when the other side has an open request back that staff did not decline; a request to someone
 * on the same registration is the registrant agreeing with themselves, so it counts at once.
 */
export function roommateStatus(row: RoommateRow, all: readonly RoommateRow[]): RoommateStatus {
  if (row.withdrawn) return { status: "WITHDRAWN" };
  if (row.decision === "DECLINED") return { status: "DECLINED" };
  if (row.decision === "APPROVED") return { status: "MUTUAL", basis: "STAFF_APPROVED" };
  if (row.fromRegistrationId === row.targetRegistrationId) return { status: "MUTUAL", basis: "SAME_REGISTRATION" };
  const back = all.some((other) => !other.withdrawn && other.decision !== "DECLINED" && isReciprocal(row, other));
  return back ? { status: "MUTUAL", basis: "BOTH_ASKED" } : { status: "ONE_SIDED" };
}

// ---------------------------------------------------------------------------
// Together groups and separation
// ---------------------------------------------------------------------------

export type RulePerson = { personId: string; registrationId: string };
export type RuleRow = {
  id: string;
  kind: LodgingRuleKind;
  personAId: string;
  personBId: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  ended: boolean;
  reason?: string;
};
export type GuardianLink = { authorityId: string; minorPersonId: string; adultPersonId: string; declaredAt: string };

export function ruleActiveOn(rule: Pick<RuleRow, "ended" | "effectiveFrom" | "effectiveUntil">, night: string) {
  return !rule.ended && (!rule.effectiveFrom || rule.effectiveFrom <= night) && (!rule.effectiveUntil || night <= rule.effectiveUntil);
}

class UnionFind {
  private parent = new Map<string, string>();
  find(id: string): string {
    const parent = this.parent.get(id) ?? id;
    if (parent === id) { this.parent.set(id, id); return id; }
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

export type TogetherSource = "HOUSEHOLD_DEFAULT" | "RESPONSIBLE_ADULT" | "STAFF";

/**
 * Who is kept together on one night, as lists of person ids (two or more). Three sources, in this order:
 * - the household default: everyone on one registration, except a person staff split out (an active split rule)
 *   and except a registration whose request is FLEXIBLE (it asked to be placeable in more than one unit);
 * - a declared responsible adult (#131) with their minor, derived from the guardian records so it follows
 *   them and never goes stale (the system keep-together rule);
 * - a staff keep-together rule.
 */
export type TogetherInput = {
  people: readonly RulePerson[];
  rules: readonly RuleRow[];
  guardians: readonly GuardianLink[];
  /** Registrations whose request says the party can be split (FLEXIBLE): the household default does not join them. */
  flexibleRegistrationIds?: readonly string[];
};

export function togetherGroupsOn(night: string, input: TogetherInput) {
  const present = new Set(input.people.map((person) => person.personId));
  const split = new Set(input.rules.filter((rule) => rule.kind === "SPLIT_HOUSEHOLD" && ruleActiveOn(rule, night)).map((rule) => rule.personAId));
  const groups = new UnionFind();
  const flexible = new Set(input.flexibleRegistrationIds ?? []);
  const byRegistration = new Map<string, string[]>();
  for (const person of input.people) {
    if (split.has(person.personId) || flexible.has(person.registrationId)) continue;
    const list = byRegistration.get(person.registrationId) ?? [];
    list.push(person.personId);
    byRegistration.set(person.registrationId, list);
  }
  for (const members of byRegistration.values()) for (const member of members.slice(1)) groups.union(members[0]!, member);
  for (const link of input.guardians) if (present.has(link.minorPersonId) && present.has(link.adultPersonId)) groups.union(link.minorPersonId, link.adultPersonId);
  for (const rule of input.rules) {
    if (rule.kind === "KEEP_TOGETHER" && rule.personBId && ruleActiveOn(rule, night) && present.has(rule.personAId) && present.has(rule.personBId)) {
      groups.union(rule.personAId, rule.personBId);
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const person of input.people) {
    const root = groups.find(person.personId);
    const list = byRoot.get(root) ?? [];
    if (!list.includes(person.personId)) list.push(person.personId);
    byRoot.set(root, list);
  }
  return [...byRoot.values()].filter((members) => members.length > 1);
}

export type SeparationViolation = { ruleId: string; personAId: string; personBId: string; firstNight: string };

/** A keep-apart rule whose two people the together rules put in one group on some night. */
export function separationViolations(nights: readonly string[], input: TogetherInput) {
  const found = new Map<string, SeparationViolation>();
  const separate = input.rules.filter((rule) => rule.kind === "SEPARATE" && rule.personBId && !rule.ended);
  if (separate.length === 0) return [];
  for (const night of nights) {
    const groups = togetherGroupsOn(night, input).map((members) => new Set(members));
    for (const rule of separate) {
      if (found.has(rule.id) || !ruleActiveOn(rule, night)) continue;
      if (groups.some((group) => group.has(rule.personAId) && group.has(rule.personBId!))) {
        found.set(rule.id, { ruleId: rule.id, personAId: rule.personAId, personBId: rule.personBId!, firstNight: night });
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export type CategoryCapacity = {
  /**
   * What the category takes per night, in the unit its demand is counted in: **rooms** for a room-type category
   * (`roomBased`), **people** for a person-based one (tents, counted areas). Null is no fixed limit.
   */
  perNight: Record<string, number | null>;
  /**
   * A room-type category: every unit of it is a numbered room, so the registrant chooses how many rooms and capacity is
   * counted in rooms against the rooms available per night (#803). Absent or false counts people.
   */
  roomBased?: boolean;
  /** Assignable units in service on at least one night. */
  unitsInService: number;
  /** Of those, how many are on the ground floor (an RV site or tent counts: nothing to climb). */
  groundLevelUnits: number;
  /** People a typical room takes (the smallest default among its rooms); null for sites, tents and counted areas. */
  unitCapacity?: number | null;
  /**
   * Room-type categories: per night, the effective bed counts (`capacityOverride ?? defaultCapacity`) of the rooms in service
   * that night, largest first. It is what "the party is larger than the beds in the rooms you picked" is worked out from.
   */
  roomBeds?: Record<string, number[]>;
  /** Whether the type's units provide linens: every unit (ALL), some (SOME) or none, null counting as not provided (NONE). */
  linens?: "ALL" | "SOME" | "NONE";
};

export type DemandRequest = { registrationId: string; category: LodgingCategory | null; nights: readonly string[]; partySize: number; roomCount?: number };

/**
 * What one request asks for in the unit its category is counted in: the rooms chosen for a room-type category, the people
 * for any other (#803).
 */
export function requestedQuantity(request: { partySize: number; roomCount?: number | null }, roomBased: boolean) {
  return roomBased ? Math.max(1, request.roomCount ?? 1) : request.partySize;
}

/** What each category's requests ask for on each night: rooms in a room-type category, people elsewhere. */
export function demandByCategoryNight(requests: readonly DemandRequest[], roomBasedCategories: ReadonlySet<LodgingCategory> = new Set()) {
  const demand = new Map<LodgingCategory, Map<string, number>>();
  for (const request of requests) {
    if (!request.category) continue;
    const quantity = requestedQuantity(request, roomBasedCategories.has(request.category));
    const byNight = demand.get(request.category) ?? new Map<string, number>();
    for (const night of request.nights) byNight.set(night, (byNight.get(night) ?? 0) + quantity);
    demand.set(request.category, byNight);
  }
  return demand;
}

/** The room-type categories of a capacity map (the ones whose demand is counted in rooms). */
export function roomBasedCategories(capacity: Partial<Record<LodgingCategory, CategoryCapacity>>): Set<LodgingCategory> {
  return new Set((Object.keys(capacity) as LodgingCategory[]).filter((category) => capacity[category]?.roomBased === true));
}

/**
 * Whether a request fits a category on every night of a stay, given what is already counted. For a room-type category
 * `roomCount` rooms are needed and `perNight` is rooms available; otherwise `partySize` people are. `capacity` null means
 * no fixed limit. Returns the first night that does not fit and the least free (rooms or people) on any night.
 */
export function categoryFits(input: {
  capacity: CategoryCapacity;
  demand: ReadonlyMap<string, number> | undefined;
  nights: readonly string[];
  partySize: number;
  /** Rooms asked for; only read for a room-type category. Defaults to 1. */
  roomCount?: number;
}) {
  if (input.capacity.unitsInService === 0) return { fits: false as const, firstFullNight: input.nights[0] ?? null, minimumAvailable: 0 };
  const needed = requestedQuantity({ partySize: input.partySize, roomCount: input.roomCount }, input.capacity.roomBased === true);
  let minimumAvailable: number | null = null;
  for (const night of input.nights) {
    const capacity = input.capacity.perNight[night];
    if (capacity === undefined) return { fits: false as const, firstFullNight: night, minimumAvailable: 0 };
    if (capacity === null) continue;
    const available = Math.max(0, capacity - (input.demand?.get(night) ?? 0));
    minimumAvailable = minimumAvailable === null ? available : Math.min(minimumAvailable, available);
    if (available < needed) return { fits: false as const, firstFullNight: night, minimumAvailable: available };
  }
  return { fits: true as const, firstFullNight: null, minimumAvailable };
}

/**
 * The most people the chosen number of rooms can hold on every one of the nights, **best case**: the `roomCount` rooms with
 * the most beds among those in service each night (the most generous way staff could place the party). Null when the
 * capacity carries no bed data (then nothing is asked).
 */
export function bestCaseBeds(capacity: Pick<CategoryCapacity, "roomBeds" | "unitCapacity"> | undefined, roomCount: number, nights: readonly string[]) {
  if (!capacity) return null;
  const rooms = Math.max(1, roomCount);
  if (!capacity.roomBeds) return capacity.unitCapacity ? capacity.unitCapacity * rooms : null;
  let beds: number | null = null;
  for (const night of nights.length > 0 ? nights : Object.keys(capacity.roomBeds)) {
    const total = (capacity.roomBeds[night] ?? []).slice(0, rooms).reduce((sum, value) => sum + value, 0);
    beds = beds === null ? total : Math.min(beds, total);
  }
  return beds;
}

/**
 * The rooms the registrant already holds for the chosen type, as the room picker's floor (#803): taken from the CURRENT view
 * (so after a save the picker follows what was saved), never above the party, and 1 when the type is not the saved one.
 */
export function heldRoomsFor(request: { category: string | null; roomCount: number } | null | undefined, category: string, partySize: number) {
  return request && request.category === category ? Math.max(1, Math.min(request.roomCount, partySize)) : 1;
}

/** Whether the party is larger than the beds of the rooms chosen, even in the best case (see `bestCaseBeds`). */
export function partyExceedsBeds(capacity: Pick<CategoryCapacity, "roomBased" | "unitCapacity" | "roomBeds"> | undefined, partySize: number, roomCount: number, nights: readonly string[] = []) {
  if (!capacity?.roomBased) return false;
  const beds = bestCaseBeds(capacity, roomCount, nights);
  return beds !== null && beds > 0 && partySize > beds;
}

export type RoomChoiceResult =
  | { ok: true; roomCount: number; bringsExtraBedding: boolean; extraBeddingNeeded: boolean }
  | { ok: false; code: "ROOM_COUNT_INVALID" | "EXTRA_BEDDING_NOT_ACKNOWLEDGED"; message: string };

/**
 * The rooms a registrant may choose, and the over-beds acknowledgement (#803). Pure, shared by the form, the private page,
 * the server and the tests.
 *
 * - A person-based category (a tent, a site, a counted area) is one unit: the room count is 1 and nothing is asked.
 * - A room-type category takes 1 up to the party size, and no more than the rooms available on every chosen night
 *   (`roomsAvailable`, from live capacity; null is no fixed limit, and the caller passes it only when the request grows).
 * - A party larger than the beds of the chosen rooms, even in the best case, is allowed (families may bring sleeping bags or
 *   air mattresses) but is acknowledged. `requireAcknowledgement` is the caller's: true when a registrant sets or changes the
 *   rooms, the party or the type, false for staff and for an unrelated edit. When it is false the stored flag is whatever
 *   was acknowledged before (`carriedAcknowledgement`), never recomputed: an edit that is not about rooms can never fail,
 *   and a staff edit never records an acknowledgement the registrant did not give.
 */
export function resolveRoomChoice(input: {
  capacity: Pick<CategoryCapacity, "roomBased" | "unitCapacity" | "roomBeds"> | undefined;
  partySize: number;
  nights?: readonly string[];
  roomCount?: number | null;
  /** What the registrant ticked. */
  bringsExtraBedding?: boolean | null;
  requireAcknowledgement: boolean;
  /** The acknowledgement already on record, kept when none is required. */
  carriedAcknowledgement?: boolean;
  roomsAvailable?: number | null;
}): RoomChoiceResult {
  if (!input.capacity?.roomBased) return { ok: true, roomCount: 1, bringsExtraBedding: false, extraBeddingNeeded: false };
  const roomCount = input.roomCount ?? 1;
  if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > input.partySize) {
    return { ok: false, code: "ROOM_COUNT_INVALID", message: `Choose between 1 and ${input.partySize} room${input.partySize === 1 ? "" : "s"}: at least one room, and no more rooms than people.` };
  }
  if (input.roomsAvailable !== null && input.roomsAvailable !== undefined && roomCount > input.roomsAvailable) {
    return { ok: false, code: "ROOM_COUNT_INVALID", message: `Only ${input.roomsAvailable} room${input.roomsAvailable === 1 ? " is" : "s are"} free for those nights. Choose fewer rooms, other nights or another type.` };
  }
  const extraBeddingNeeded = partyExceedsBeds(input.capacity, input.partySize, roomCount, input.nights ?? []);
  if (!extraBeddingNeeded) return { ok: true, roomCount, bringsExtraBedding: false, extraBeddingNeeded: false };
  if (input.bringsExtraBedding === true) return { ok: true, roomCount, bringsExtraBedding: true, extraBeddingNeeded: true };
  if (input.requireAcknowledgement) {
    return { ok: false, code: "EXTRA_BEDDING_NOT_ACKNOWLEDGED", message: "Your party is larger than the beds in the rooms you picked. Confirm that you will bring sleeping bags or air mattresses for the extra people." };
  }
  return { ok: true, roomCount, bringsExtraBedding: input.carriedAcknowledgement === true, extraBeddingNeeded: true };
}

/**
 * The general bedding note for a type (#803): nearly every room is bring-your-own-bedding. Nothing when every unit of the
 * type provides linens, "Most rooms: ..." when only some do, and the plain note otherwise (an unknown counts as not provided).
 */
export function beddingNote(linens: CategoryCapacity["linens"] | undefined) {
  if (linens === "ALL") return null;
  if (linens === "SOME") return "Most rooms: bring your own bedding";
  return "Bring your own bedding (sheets, pillow, blanket)";
}

/** The sentence the form and the private page show when the party is larger than the beds of the rooms picked. */
export const extraBeddingNote = "Your party is larger than the beds in the rooms you picked; bring sleeping bags or air mattresses for the extra people.";

// ---------------------------------------------------------------------------
// The staff review queue
// ---------------------------------------------------------------------------

export const reviewKinds = [
  "ONE_SIDED_ROOMMATE",
  "ROOMMATE_TARGET_UNAVAILABLE",
  "CONFLICT_SEPARATION",
  "CONFLICT_CATEGORY",
  "IMPOSSIBLE_DATES",
  "CATEGORY_UNAVAILABLE",
  "PAST_DEADLINE",
  "OVER_CAPACITY",
  "ACCESSIBILITY_NEEDED",
  "ACCESSIBILITY_UNMET",
  "CHANGE_REQUESTED",
  "PRICE_DIFFERS",
  "PARTY_EXCEEDS_ATTENDEES",
  "EXTRA_BEDDING",
  "PROMOTED_UNCONFIRMED",
] as const;
export type ReviewKind = (typeof reviewKinds)[number];

export const reviewKindLabels: Record<ReviewKind, string> = {
  ONE_SIDED_ROOMMATE: "One-sided roommate request",
  ROOMMATE_TARGET_UNAVAILABLE: "Roommate is not registered",
  CONFLICT_SEPARATION: "Conflicts with a keep-apart rule",
  CONFLICT_CATEGORY: "Roommates asked for different lodging",
  IMPOSSIBLE_DATES: "Dates cannot work",
  CATEGORY_UNAVAILABLE: "Lodging type not available",
  PAST_DEADLINE: "Changed after the deadline",
  OVER_CAPACITY: "More requested than the lodging takes",
  ACCESSIBILITY_NEEDED: "Accessibility need",
  ACCESSIBILITY_UNMET: "Accessibility need cannot be met",
  CHANGE_REQUESTED: "Change requested",
  PRICE_DIFFERS: "Lodging charge differs from the request",
  PARTY_EXCEEDS_ATTENDEES: "Party is larger than the registration",
  EXTRA_BEDDING: "Party is larger than the beds; bringing extra bedding",
  PROMOTED_UNCONFIRMED: "Promoted from the waitlist with an unconfirmed lodging request",
};

/** Kinds that disclose an accessibility flag: only staff with VIEW_SENSITIVE_DATA see them. */
export const sensitiveReviewKinds: ReadonlySet<ReviewKind> = new Set<ReviewKind>(["ACCESSIBILITY_NEEDED", "ACCESSIBILITY_UNMET"]);

export type RequestSnapshot = {
  requestId: string;
  version: number;
  registrationId: string;
  category: LodgingCategory | null;
  firstNight: string | null;
  lastNight: string | null;
  partySize: number;
  /** Rooms the registrant chose (1 for anything that is not a room-type category). */
  roomCount: number;
  /** The registrant acknowledged that the party is larger than the beds in the chosen rooms. */
  bringsExtraBedding: boolean;
  groundFloorNeeded: boolean;
  accessibleRoomNeeded: boolean;
  privateRoomRequested: boolean;
  householdPreference: HouseholdPreference;
  afterDeadline: boolean;
  source: LodgingRequestSource;
  updatedAt: string;
};

export type RegistrationFact = { confirmationCode: string; label: string; active: boolean };

/** A lodging charge change after the registration's saved promo code (#803): the list change and what the registrant pays. */
export type ChargeImpactFact = { promoCode: string | null; coversLodging: boolean; sponsored: boolean; registrantDeltaCents: number; discountDeltaCents: number; belowMinimumAfter?: boolean };

/**
 * What a church owes is computed from the registration's redemption (the discount recorded when the code was used) and any
 * promo-code adjustments, none of which a lodging edit or a manual Payments adjustment moves. So a sponsored registration whose
 * sponsor share would change needs the finance office before anyone adjusts anything. Interim guidance (#803): nothing here
 * changes a church's bill.
 */
export const CHURCH_SPONSOR_CONTACT_LEAD = "Contact the finance office before changing anything in Payments.";
export const CHURCH_SPONSOR_WARNING = "This registration's church sponsorship does not change automatically. The church's bill still reflects the original lodging. Contact the finance office before adjusting.";

/** A church-sponsored code whose sponsor share the change would move. */
export function churchSponsorNeedsReview(impact: { sponsored: boolean; discountDeltaCents: number } | null | undefined) {
  return Boolean(impact?.sponsored && impact.discountDeltaCents !== 0);
}

export type ReviewFacts = {
  /** The event's bookable nights. */
  nights: readonly string[];
  registrations: ReadonlyMap<string, RegistrationFact>;
  people: readonly RulePerson[];
  requests: readonly RequestSnapshot[];
  roommates: readonly RoommateRow[];
  rules: readonly RuleRow[];
  guardians: readonly GuardianLink[];
  capacity: Partial<Record<LodgingCategory, CategoryCapacity>>;
  /** Open registrant changes the edit policy kept from applying. */
  changeRequests?: ReadonlyArray<{
    id: string; registrationId: string; category: LodgingCategory | null; chargedCents?: number; requestedCents?: number;
    /** What the registrant asked for: the rooms and whether they will bring sleeping bags or air mattresses (#803). */
    partySize?: number; roomCount?: number; bringsExtraBedding?: boolean;
    /** The change as the registrant would feel it after their saved promo code. */
    impact?: ChargeImpactFact;
  }>;
  /** What each active registration was charged for lodging, against what its request costs at today's rates. */
  lodgingCharges?: ReadonlyArray<{ registrationId: string; chargedCents: number; currentCents: number; impact?: ChargeImpactFact }>;
  /** Registrations promoted from the waitlist (automatically or by staff): their lodging request was never priced or confirmed. */
  promotedRegistrationIds?: readonly string[];
};

export type ReviewItem = {
  key: string;
  kind: ReviewKind;
  /** Changes when the thing the item is about changes, so an acknowledged item that changes comes back. */
  fingerprint: string;
  registrationIds: string[];
  title: string;
  detail: string;
  sensitive: boolean;
  /** For a one-sided roommate request: the row staff approve or decline. */
  roommateRequestId: string | null;
  /** Extra flags on the item. CHURCH_SPONSOR_REVIEW: a church-sponsored code's share would move; contact the finance office. */
  flags?: Array<"CHURCH_SPONSOR_REVIEW">;
};

/** The nights a request covers: its own window, else every bookable night. */
export function requestNights(request: Pick<RequestSnapshot, "firstNight" | "lastNight">, eventNights: readonly string[]) {
  return request.firstNight && request.lastNight ? nightsInclusive(request.firstNight, request.lastNight) : [...eventNights];
}

function label(facts: ReviewFacts, registrationId: string) {
  return facts.registrations.get(registrationId)?.label ?? "an unknown registration";
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Everything staff should look at, derived from the facts alone: one-sided, conflicting and impossible
 * requests, requests changed after the deadline, and requests over capacity. Pure and deterministic.
 * Items that disclose an accessibility flag are marked `sensitive`; the caller drops them for staff who may not see them.
 */
function signedDollars(cents: number) {
  return `${cents < 0 ? "-" : "+"}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * What staff are told after saving a lodging change that alters the charge (#803): the list change and, when the
 * registration holds a saved promo code, what the registrant really pays differently (and the sponsor's share for a
 * church-sponsored code), and, for a sponsored code whose share is in play, the finance-office warning. The figures are the
 * change THIS edit makes; the cumulative picture ("originally charged X, now costs Y") is context, never the figure to record.
 * For a church-flagged result nothing says to adjust Payments: the church's bill does not follow a lodging edit (see
 * `CHURCH_SPONSOR_WARNING`).
 */
export function chargeChangeSentence(result: { chargeDeltaCents?: number; registrantDeltaCents?: number; sponsorDeltaCents?: number; belowMinimumAfter?: boolean; churchSponsorReview?: boolean; originallyChargedCents?: number; requestNowCostsCents?: number; promo?: { code: string; coversLodging: boolean; sponsored: boolean } | null }) {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const list = signedDollars(result.chargeDeltaCents ?? 0);
  const promo = result.promo;
  const context = result.originallyChargedCents !== undefined && result.requestNowCostsCents !== undefined ? ` Originally charged ${dollars(result.originallyChargedCents)} at submission; the request now costs ${dollars(result.requestNowCostsCents)}.` : "";
  const review = result.churchSponsorReview === true && promo?.sponsored === true;
  const lead = review ? `${CHURCH_SPONSOR_CONTACT_LEAD} ` : "";
  const warning = review ? ` ${CHURCH_SPONSOR_WARNING}` : "";
  if (!promo) return `This edit changes the lodging charge by ${list}, but the registration's total was not changed.${context}`;
  if (!promo.coversLodging) return `This edit changes the lodging charge by ${list} at list price. Code ${promo.code} does not apply to the lodging line on this registration (it was submitted before codes covered lodging), so the registrant's change is ${list}. The registration's total was not changed.${context}`;
  const minimum = result.belowMinimumAfter ? ` After this edit the registration would be under code ${promo.code}'s minimum, so an amendment would refuse it and the code would no longer apply.` : "";
  const figures = result.chargeDeltaCents === undefined ? "" : `This edit changes the lodging charge by ${list} at list price. A promo code applies: after ${promo.code} the registrant's change is ${signedDollars(result.registrantDeltaCents ?? 0)}${promo.sponsored ? ` and the sponsor's share is ${signedDollars(result.sponsorDeltaCents ?? 0)}` : ""}.`;
  return `${lead}${figures}${minimum}${warning}${figures ? " The registration's total was not changed." : ""}${context}`.trim();
}

/** The list change, and the change after the registration's promo code, in words. Empty when no code is involved. */
function impactWords(impact: ChargeImpactFact | undefined) {
  if (!impact?.promoCode) return "";
  if (!impact.coversLodging) return ` Code ${impact.promoCode} does not apply to the lodging line on this registration (it was submitted before codes covered lodging), so the registrant's change is the list change.`;
  return ` After code ${impact.promoCode} the registrant's change is ${signedDollars(impact.registrantDeltaCents)}${impact.sponsored ? `, and the sponsor's share ${signedDollars(impact.discountDeltaCents)}` : `, with ${signedDollars(impact.discountDeltaCents)} more or less discount`}.${impact.belowMinimumAfter ? ` The registration would then be under the code's minimum, so an amendment would refuse it and the code would no longer apply.` : ""}${churchSponsorNeedsReview(impact) ? ` ${CHURCH_SPONSOR_WARNING}` : ""}`;
}

export function buildReviewItems(facts: ReviewFacts): ReviewItem[] {
  const items: ReviewItem[] = [];
  const active = (registrationId: string) => facts.registrations.get(registrationId)?.active === true;
  const requestByRegistration = new Map(facts.requests.map((request) => [request.registrationId, request]));
  const eventNights = new Set(facts.nights);
  const personRegistration = new Map(facts.people.map((person) => [person.personId, person.registrationId]));
  const push = (item: Omit<ReviewItem, "sensitive" | "roommateRequestId"> & { roommateRequestId?: string | null }) =>
    items.push({ ...item, roommateRequestId: item.roommateRequestId ?? null, sensitive: sensitiveReviewKinds.has(item.kind) });

  // --- Roommate requests ---------------------------------------------------
  const mutualPairs = new Map<string, RoommateRow>();
  for (const row of facts.roommates) {
    if (row.withdrawn || row.decision === "DECLINED" || !active(row.fromRegistrationId)) continue;
    if (!active(row.targetRegistrationId)) {
      push({
        key: `roommate:${row.id}`, kind: "ROOMMATE_TARGET_UNAVAILABLE", fingerprint: `${row.id}:${row.decision}:inactive`,
        registrationIds: [row.fromRegistrationId, row.targetRegistrationId],
        title: `${label(facts, row.fromRegistrationId)} asked for a roommate who is no longer registered`,
        detail: `The registration ${label(facts, row.targetRegistrationId)} was cancelled or removed.`,
        roommateRequestId: row.id,
      });
      continue;
    }
    const standing = roommateStatus(row, facts.roommates);
    if (standing.status === "ONE_SIDED") {
      push({
        key: `roommate:${row.id}`, kind: "ONE_SIDED_ROOMMATE", fingerprint: `${row.id}:${row.decision}`,
        registrationIds: [row.fromRegistrationId, row.targetRegistrationId],
        title: `${label(facts, row.fromRegistrationId)} asked to room with ${label(facts, row.targetRegistrationId)}`,
        detail: "The other registration has not asked back. Approve it to treat it as mutual, or decline it.",
        roommateRequestId: row.id,
      });
    } else if (standing.status === "MUTUAL" && row.fromRegistrationId !== row.targetRegistrationId) {
      const key = pairKey(row.fromRegistrationId, row.targetRegistrationId);
      if (!mutualPairs.has(key)) mutualPairs.set(key, row);
    }
  }

  const rulesById = new Map(facts.rules.map((rule) => [rule.id, rule]));
  for (const [key, row] of mutualPairs) {
    const left = requestByRegistration.get(row.fromRegistrationId);
    const right = requestByRegistration.get(row.targetRegistrationId);
    const registrationIds = [row.fromRegistrationId, row.targetRegistrationId];
    const names = `${label(facts, row.fromRegistrationId)} and ${label(facts, row.targetRegistrationId)}`;
    if (left && right) {
      if (left.category && right.category && left.category !== right.category) {
        push({
          key: `category:${key}`, kind: "CONFLICT_CATEGORY", fingerprint: `${left.requestId}@${left.version}|${right.requestId}@${right.version}`,
          registrationIds,
          title: `${names} want to room together but asked for different lodging`,
          detail: `${lodgingCategoryLabels[left.category]} and ${lodgingCategoryLabels[right.category]}.`,
        });
      }
      const leftNights = new Set(requestNights(left, facts.nights));
      const overlap = requestNights(right, facts.nights).some((night) => leftNights.has(night));
      if (!overlap) {
        push({
          key: `dates:${key}`, kind: "IMPOSSIBLE_DATES", fingerprint: `${left.requestId}@${left.version}|${right.requestId}@${right.version}`,
          registrationIds,
          title: `${names} want to room together but share no night`,
          detail: "Their requested nights do not overlap.",
        });
      }
    }
    // A keep-apart rule between a person on each side.
    for (const rule of facts.rules) {
      if (rule.kind !== "SEPARATE" || rule.ended || !rule.personBId) continue;
      const a = personRegistration.get(rule.personAId);
      const b = personRegistration.get(rule.personBId);
      const sides = new Set(registrationIds);
      const touches = a !== undefined && b !== undefined && a !== b && sides.has(a) && sides.has(b)
        && (row.fromPersonId === null || [rule.personAId, rule.personBId].includes(row.fromPersonId))
        && (row.targetPersonId === null || [rule.personAId, rule.personBId].includes(row.targetPersonId));
      if (touches) {
        push({
          key: `separate-roommate:${rule.id}:${key}`, kind: "CONFLICT_SEPARATION", fingerprint: `${rule.id}:${row.id}:${row.decision}`,
          registrationIds,
          title: `${names} want to room together but a keep-apart rule covers two of their people`,
          detail: "End the rule, or decline the roommate request.",
        });
      }
    }
  }

  // --- Keep-apart rules against the together groups ------------------------
  const flexibleRegistrationIds = facts.requests.filter((request) => request.householdPreference === "FLEXIBLE").map((request) => request.registrationId);
  for (const violation of separationViolations(facts.nights, { people: facts.people, rules: facts.rules, guardians: facts.guardians, flexibleRegistrationIds })) {
    const rule = rulesById.get(violation.ruleId);
    const a = personRegistration.get(violation.personAId);
    const b = personRegistration.get(violation.personBId);
    push({
      key: `separate:${violation.ruleId}`, kind: "CONFLICT_SEPARATION", fingerprint: `${violation.ruleId}:${violation.firstNight}`,
      registrationIds: [...new Set([a, b].filter((value): value is string => Boolean(value)))],
      title: "A keep-apart rule conflicts with who is kept together",
      detail: `From ${violation.firstNight} the household, responsible-adult or keep-together rules put these two people in one group${rule?.reason ? ` (rule reason: ${rule.reason})` : ""}.`,
    });
  }

  // --- Requests -------------------------------------------------------------
  const demandInput: DemandRequest[] = [];
  for (const request of facts.requests) {
    if (!active(request.registrationId)) continue;
    const who = label(facts, request.registrationId);
    const nights = requestNights(request, facts.nights);
    demandInput.push({ registrationId: request.registrationId, category: request.category, nights, partySize: request.partySize, roomCount: request.roomCount });
    const fingerprint = `${request.requestId}@${request.version}`;
    const attendeeCount = facts.people.filter((person) => person.registrationId === request.registrationId).length;
    if (attendeeCount > 0 && request.partySize > attendeeCount) {
      push({
        key: `party:${request.registrationId}`, kind: "PARTY_EXCEEDS_ATTENDEES", fingerprint: `${fingerprint}:${attendeeCount}`, registrationIds: [request.registrationId],
        title: `${who} asked for lodging for ${request.partySize}, and has ${attendeeCount} attendee${attendeeCount === 1 ? "" : "s"}`,
        detail: "People were removed from the registration after the request was made. Correct the party size.",
      });
    }
    if (request.category && request.bringsExtraBedding) {
      push({
        key: `bedding:${request.registrationId}`, kind: "EXTRA_BEDDING", fingerprint, registrationIds: [request.registrationId],
        title: `${who}: party of ${request.partySize} in ${request.roomCount} ${request.roomCount === 1 ? "room" : "rooms"}, bringing sleeping bags or air mattresses`,
        detail: `The party is larger than the beds in the rooms chosen (even counting the largest rooms), and the registrant acknowledged bringing sleeping bags or air mattresses. Placing them is allowed with a warning.`,
      });
    }
    if (request.afterDeadline) {
      push({
        key: `late:${request.registrationId}`, kind: "PAST_DEADLINE", fingerprint, registrationIds: [request.registrationId],
        title: `${who} changed lodging after the deadline`,
        detail: "Staff made this change after registrants could no longer edit. Check it still fits.",
      });
    }
    if (nights.some((night) => !eventNights.has(night)) || nights.length === 0) {
      push({
        key: `window:${request.registrationId}`, kind: "IMPOSSIBLE_DATES", fingerprint, registrationIds: [request.registrationId],
        title: `${who} asked for nights outside the event`,
        detail: "The event's bookable nights changed after this request was made.",
      });
    }
    if (request.category) {
      const capacity = facts.capacity[request.category];
      if (!capacity || capacity.unitsInService === 0) {
        push({
          key: `category:${request.registrationId}`, kind: "CATEGORY_UNAVAILABLE", fingerprint: `${fingerprint}:${request.category}`, registrationIds: [request.registrationId],
          title: `${who} asked for ${lodgingCategoryLabels[request.category].toLowerCase()}, which has nothing in service`,
          detail: "Every unit of that type is unavailable, held or not assignable.",
        });
      } else if (request.groundFloorNeeded && capacity.groundLevelUnits === 0) {
        push({
          key: `ground:${request.registrationId}`, kind: "ACCESSIBILITY_UNMET", fingerprint: `${fingerprint}:${request.category}`, registrationIds: [request.registrationId],
          title: `${who} needs a ground floor, and ${lodgingCategoryLabels[request.category].toLowerCase()} has none`,
          detail: "Suggest a different lodging type.",
        });
      }
    }
    if (request.groundFloorNeeded || request.accessibleRoomNeeded) {
      const needs = [request.groundFloorNeeded ? "ground floor" : null, request.accessibleRoomNeeded ? "accessible room" : null].filter(Boolean).join(" and ");
      push({
        key: `access:${request.registrationId}`, kind: "ACCESSIBILITY_NEEDED", fingerprint, registrationIds: [request.registrationId],
        title: `${who} needs a ${needs}`,
        detail: "Yes/no flags only. Place them where it is met.",
      });
    }
  }

  // --- Changes the edit policy kept from applying -----------------------------
  for (const change of facts.changeRequests ?? []) {
    if (!active(change.registrationId)) continue;
    push({
      key: `change:${change.id}`, kind: "CHANGE_REQUESTED", fingerprint: `${change.id}:${change.chargedCents ?? ""}:${change.requestedCents ?? ""}:${change.impact?.registrantDeltaCents ?? ""}`, registrationIds: [change.registrationId],
      title: `${label(facts, change.registrationId)}: lodging charge change requested${change.chargedCents !== undefined && change.requestedCents !== undefined ? ` (list ${signedDollars(change.requestedCents - change.chargedCents)})` : ""}${change.category ? `, to ${lodgingCategoryLabels[change.category].toLowerCase()}` : ""}${change.partySize !== undefined ? `: ${change.partySize} ${change.partySize === 1 ? "person" : "people"}${change.category && change.roomCount !== undefined ? `, ${change.roomCount} ${change.roomCount === 1 ? "room" : "rooms"}` : ""}${change.bringsExtraBedding ? ", bringing sleeping bags or air mattresses" : ""}` : ""}`,
      detail: `A registrant's change that alters the lodging charge is never applied by itself. ${churchSponsorNeedsReview(change.impact) ? `${CHURCH_SPONSOR_CONTACT_LEAD} Make the change for them only if it is right.` : "Make the change for them if it is right, then adjust the charge in Payments."}${impactWords(change.impact)}`,
      ...(churchSponsorNeedsReview(change.impact) ? { flags: ["CHURCH_SPONSOR_REVIEW" as const] } : {}),
    });
  }

  // --- Lodging charge against the request ---------------------------------------
  for (const charge of facts.lodgingCharges ?? []) {
    if (!active(charge.registrationId) || charge.chargedCents === charge.currentCents) continue;
    const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    push({
      key: `price:${charge.registrationId}`, kind: "PRICE_DIFFERS", fingerprint: `${charge.chargedCents}:${charge.currentCents}:${charge.impact?.registrantDeltaCents ?? ""}`, registrationIds: [charge.registrationId],
      title: `${label(facts, charge.registrationId)} was charged ${dollars(charge.chargedCents)} for lodging; the request costs ${dollars(charge.currentCents)}`,
      detail: `The charge is never changed automatically after submission. ${churchSponsorNeedsReview(charge.impact) ? CHURCH_SPONSOR_CONTACT_LEAD : "If it should follow the request, adjust it in Payments."}${impactWords(charge.impact)}`,
      ...(churchSponsorNeedsReview(charge.impact) ? { flags: ["CHURCH_SPONSOR_REVIEW" as const] } : {}),
    });
  }

  // --- Over capacity --------------------------------------------------------
  // A room-type category is counted in rooms (the rooms each request chose against the rooms available that night); every
  // other category is counted in people.
  const demand = demandByCategoryNight(demandInput, roomBasedCategories(facts.capacity));
  for (const [category, byNight] of demand) {
    const capacity = facts.capacity[category];
    if (!capacity || capacity.unitsInService === 0) continue;
    const inRooms = capacity.roomBased === true;
    for (const night of [...byNight.keys()].sort()) {
      const limit = capacity.perNight[night];
      const asked = byNight.get(night) ?? 0;
      if (limit === null || limit === undefined || asked <= limit) continue;
      push({
        key: `over:${category}`, kind: "OVER_CAPACITY", fingerprint: `${category}:${night}:${asked}:${limit}`,
        registrationIds: demandInput.filter((request) => request.category === category).map((request) => request.registrationId),
        title: inRooms
          ? `${lodgingCategoryLabels[category]}: ${asked} ${asked === 1 ? "room" : "rooms"} asked on ${night}, ${limit} available`
          : `${lodgingCategoryLabels[category]}: ${asked} people asked on ${night}, room for ${limit}`,
        detail: inRooms
          ? "Requests for this type are counted in rooms. Move some requests, raise capacity, or hold the line at selection."
          : "Requests are counted by people, not by room. Move some requests, raise capacity, or hold the line at selection.",
      });
      break;
    }
  }

  // --- Promoted from the waitlist with a lodging request ---------------------------
  // A promotion never waits on lodging and never charges for it, so the request is listed for the event team to confirm
  // when its type no longer fits or it is priced but carries no lodging line.
  for (const registrationId of facts.promotedRegistrationIds ?? []) {
    if (!active(registrationId)) continue;
    const request = facts.requests.find((candidate) => candidate.registrationId === registrationId);
    if (!request?.category) continue;
    const charge = (facts.lodgingCharges ?? []).find((candidate) => candidate.registrationId === registrationId);
    const unpriced = Boolean(charge && charge.currentCents > 0 && charge.chargedCents === 0);
    const capacity = facts.capacity[request.category];
    const byNight = demand.get(request.category);
    const full = Boolean(capacity && capacity.unitsInService > 0 && requestNights(request, facts.nights).some((night) => {
      const limit = capacity.perNight[night];
      return limit !== null && limit !== undefined && (byNight?.get(night) ?? 0) > limit;
    }));
    if (!unpriced && !full) continue;
    push({
      key: `promoted:${registrationId}`, kind: "PROMOTED_UNCONFIRMED", fingerprint: `${request.requestId}@${request.version}:${full ? "full" : "fits"}:${unpriced ? "unpriced" : "priced"}`, registrationIds: [registrationId],
      title: `${label(facts, registrationId)} was promoted from the waitlist with an unconfirmed lodging request`,
      detail: `${full ? "The requested type is full for those nights. " : ""}${unpriced ? "No lodging charge was added. " : ""}Confirm or change the lodging, and add any charge in Payments.`,
    });
  }

  return items.sort((a, b) => reviewKinds.indexOf(a.kind) - reviewKinds.indexOf(b.kind) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// General export: only approved fields
// ---------------------------------------------------------------------------

export const LODGING_REQUEST_CSV_HEADERS = [
  "Confirmation code",
  "Lodging type",
  "First night",
  "Last night",
  "People",
  "Rooms",
  "Extra bedding",
  "Private room requested",
  "Household preference",
  "Roommate requests (mutual)",
  "Roommate requests (waiting)",
  "Last changed",
] as const;
export const LODGING_REQUEST_ACCESSIBILITY_HEADERS = ["Ground floor needed", "Accessible room needed"] as const;

export type LodgingRequestExportRow = {
  confirmationCode: string;
  category: LodgingCategory | null;
  firstNight: string | null;
  lastNight: string | null;
  partySize: number;
  roomCount: number;
  bringsExtraBedding: boolean;
  privateRoomRequested: boolean;
  householdPreference: HouseholdPreference;
  mutualRoommates: number;
  waitingRoommates: number;
  updatedAt: string;
  groundFloorNeeded: boolean;
  accessibleRoomNeeded: boolean;
};

const yesNo = (value: boolean) => (value ? "Yes" : "No");

/**
 * The cells of one export row. Approved fields only: no names, contact details, free text or restricted
 * evidence. The accessibility columns exist only when the caller holds VIEW_SENSITIVE_DATA.
 */
export function lodgingRequestExportCells(row: LodgingRequestExportRow, includeAccessibility: boolean): Array<string | number> {
  const cells: Array<string | number> = [
    row.confirmationCode,
    row.category ? lodgingCategoryLabels[row.category] : "No preference",
    row.firstNight ?? "",
    row.lastNight ?? "",
    row.partySize,
    row.roomCount,
    yesNo(row.bringsExtraBedding),
    yesNo(row.privateRoomRequested),
    row.householdPreference === "TOGETHER" ? "Together" : "Flexible",
    row.mutualRoommates,
    row.waitingRoommates,
    row.updatedAt,
  ];
  if (includeAccessibility) cells.push(yesNo(row.groundFloorNeeded), yesNo(row.accessibleRoomNeeded));
  return cells;
}

/**
 * Whether a changed request asks for more than the one it replaces: a different type, a larger party, more rooms, or a
 * night the earlier request did not cover. Only then does the type's capacity need checking again.
 */
export function requestGrew(
  previous: { category: LodgingCategory | null; partySize: number; roomCount?: number; nights: readonly string[] } | null,
  next: { category: LodgingCategory | null; partySize: number; roomCount?: number; nights: readonly string[] },
) {
  if (!previous || previous.category !== next.category || next.partySize > previous.partySize) return true;
  if ((next.roomCount ?? 1) > (previous.roomCount ?? 1)) return true;
  const had = new Set(previous.nights);
  return next.nights.some((night) => !had.has(night));
}
