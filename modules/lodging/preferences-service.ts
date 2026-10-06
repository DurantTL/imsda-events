import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  calendarDay,
  lodgingCategoryLabels,
  nightsInclusive,
  projectAvailability,
  rateForCategory,
  type LodgingCategory,
  type LodgingRate,
  type UnitNightState,
} from "@/modules/lodging/domain";
import { isOfferLapsed } from "@/modules/lodging/assignment-domain";
import { LodgingError } from "@/modules/lodging/errors";
import {
  buildReviewItems,
  categoryFits,
  demandByCategoryNight,
  isPastLodgingDeadline,
  lodgingActiveRegistrationStatuses,
  lodgingDeadlineDay,
  lodgingRequestSchema,
  lodgingSettingsSchema,
  normalizeConfirmationCode,
  normalizeName,
  registrantRoommateSchema,
  requestGrew,
  requestNights,
  roommateStatus,
  ruleActionSchema,
  ruleCreateSchema,
  staffLodgingRequestSchema,
  staffRoommateSchema,
  type CategoryCapacity,
  type FullBehavior,
  type GuardianLink,
  type HouseholdPreference,
  type LodgingRequestExportRow,
  type LodgingRequestSource,
  type LodgingRuleKind,
  type RegistrationFact,
  type RequestSnapshot,
  type ReviewItem,
  type RoommateRow,
  type RoommateStatus,
  type RuleRow,
} from "@/modules/lodging/preferences-domain";
import { LODGING_LINE_KEY, lodgingCharge, unitsForParty } from "@/modules/lodging/pricing";
import { isChurchBilledBillingMode } from "@/modules/club-registrations/per-person-price";
import { lockEventLodgingUnits, lodgingTransactionTimeoutMs, nightsFor, touchEventLodgingCapacity } from "@/modules/lodging/service";

/**
 * Lodging preferences, roommate requests, household rules and the staff review (#199, slice 2).
 *
 * A request is what a guest asked for. Nothing here assigns a unit, holds an assignment, or moves anyone (#200).
 * Authorization is the caller's job (the routes and pages check the permission for the event in the URL, and the
 * registrant routes check the private registration link); every function here still refuses a registration,
 * person, rule or roommate request that is not on the event it was handed.
 *
 * Privacy: accessibility is two yes/no flags; the audit log records that they changed, never their values;
 * the registrant-facing view never reveals who asked to room with them or any contact detail.
 */

export type Tx = Prisma.TransactionClient;
export type Client = Tx | PrismaClient;

const toDate = (night: string) => new Date(`${night}T00:00:00Z`);
const toNight = (date: Date) => date.toISOString().slice(0, 10);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

function verificationRequired() {
  return new LodgingError("EDIT_POLICY_REQUIRES_VERIFICATION", "This event requires verification before this change. To change this, contact the event team.");
}

export type Actor =
  | { kind: "REGISTRANT"; accessTokenId: string }
  | { kind: "STAFF"; userId: string; canSeeSensitive: boolean };

// ---------------------------------------------------------------------------
// Event context, capacity and demand
// ---------------------------------------------------------------------------

export async function loadContext(client: Client, eventId: string) {
  const lodging = await client.eventLodging.findUnique({
    where: { eventId },
    include: { event: { select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true, registrationClosesOn: true, attendeeEditPolicy: true, billingMode: true } } },
  });
  if (!lodging) throw new LodgingError("NO_PROPERTY", "This event has no lodging set up.");
  const nights = nightsFor(lodging);
  const eventStartDay = calendarDay(lodging.event.startsAt, lodging.event.timezone);
  const deadlineDay = lodgingDeadlineDay({
    preferencesDeadline: lodging.preferencesDeadline ? toNight(lodging.preferencesDeadline) : null,
    registrationClosesOn: lodging.event.registrationClosesOn,
    eventStartDay,
  });
  return {
    eventLodgingId: lodging.id,
    eventId,
    timezone: lodging.event.timezone,
    nights,
    deadlineDay,
    editPolicy: lodging.event.attendeeEditPolicy,
    /** A church-billed event bills through its invoice: the expected lodging charge on its registrations is always 0. */
    churchBilled: isChurchBilledBillingMode(lodging.event.billingMode),
    collectsPreferences: lodging.collectsPreferences,
    fullBehavior: lodging.fullBehavior as FullBehavior,
    preferencesDeadline: lodging.preferencesDeadline ? toNight(lodging.preferencesDeadline) : null,
  };
}
export type Context = Awaited<ReturnType<typeof loadContext>>;

/** Per category: people the in-service units take each night, how many units are in service, and how many are ground level. */
export async function loadCategoryCapacity(client: Client, context: Pick<Context, "eventLodgingId" | "nights">) {
  const rows = await client.eventLodgingUnit.findMany({
    where: { eventLodgingId: context.eventLodgingId },
    include: { unit: true, holds: { where: { releasedAt: null }, select: { id: true, firstNight: true, lastNight: true } } },
  });
  const capacity: Partial<Record<LodgingCategory, CategoryCapacity>> = {};
  const unitIdsByCategory = new Map<LodgingCategory, string[]>();
  const states: Array<{ category: LodgingCategory; groundLevel: boolean; roomSleeps: number | null; state: UnitNightState }> = [];
  for (const row of rows) {
    const category = row.unit.category;
    if (!category || row.retired) continue;
    unitIdsByCategory.set(category, [...(unitIdsByCategory.get(category) ?? []), row.id]);
    states.push({
      category,
      groundLevel: row.unit.groundLevel || row.unit.kind !== "ROOM",
      // A room's own size (the smallest default among a category's rooms) is what a per-room charge divides by.
      roomSleeps: row.unit.kind === "ROOM" && !row.unit.isArea && row.assignable && row.defaultCapacity !== null && row.defaultCapacity > 0 ? row.defaultCapacity : null,
      state: {
        unitId: row.id,
        assignable: row.assignable,
        retired: false,
        defaultCapacity: row.defaultCapacity,
        capacityOverride: row.capacityOverride,
        unavailable: row.unavailable,
        activeFrom: row.unit.activeFrom ? toNight(row.unit.activeFrom) : null,
        activeUntil: row.unit.activeUntil ? toNight(row.unit.activeUntil) : null,
        holds: row.holds.map((hold) => ({ id: hold.id, firstNight: toNight(hold.firstNight), lastNight: toNight(hold.lastNight) })),
      },
    });
  }
  const projection = projectAvailability({ nights: context.nights, units: states.map((entry) => entry.state) });
  for (const entry of states) {
    const rowsForUnit = projection.get(entry.state.unitId) ?? [];
    const inService = rowsForUnit.some((night) => night.status === "AVAILABLE");
    const current = capacity[entry.category] ?? { perNight: Object.fromEntries(context.nights.map((night) => [night, 0 as number | null])), unitsInService: 0, groundLevelUnits: 0, unitCapacity: null };
    if (entry.roomSleeps !== null) current.unitCapacity = current.unitCapacity === null || current.unitCapacity === undefined ? entry.roomSleeps : Math.min(current.unitCapacity, entry.roomSleeps);
    if (inService) {
      current.unitsInService += 1;
      if (entry.groundLevel) current.groundLevelUnits += 1;
    }
    for (const night of rowsForUnit) {
      if (night.status !== "AVAILABLE") continue;
      const before = current.perNight[night.night];
      current.perNight[night.night] = night.capacity === null || before === null ? null : (before ?? 0) + night.capacity;
    }
    capacity[entry.category] = current;
  }
  return { capacity, unitIdsByCategory };
}

export type RequestRow = {
  requestId: string;
  registrationId: string;
  version: number;
  category: LodgingCategory | null;
  firstNight: string | null;
  lastNight: string | null;
  partySize: number;
  groundFloorNeeded: boolean;
  accessibleRoomNeeded: boolean;
  privateRoomRequested: boolean;
  householdPreference: HouseholdPreference;
  source: LodgingRequestSource;
  afterDeadline: boolean;
  createdAt: Date;
};

export async function loadRates(client: Client, eventLodgingId: string) {
  const rows = await client.eventLodgingRate.findMany({ where: { eventLodgingId } });
  const rates: Partial<Record<LodgingCategory, LodgingRate | null>> = {};
  for (const rate of rows) rates[rate.category] = { amountCents: rate.amountCents, basis: rate.basis, minimumNights: rate.minimumNights };
  return rates;
}

export async function loadCurrentRequests(client: Client, eventId: string, where: Prisma.EventLodgingRequestWhereInput = {}): Promise<RequestRow[]> {
  const requests = await client.eventLodgingRequest.findMany({
    where: { eventId, ...where },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  return requests.flatMap((request) => {
    const version = request.versions[0];
    if (!version) return [];
    return [{
      requestId: request.id,
      registrationId: request.registrationId,
      version: version.version,
      category: version.category,
      firstNight: version.firstNight ? toNight(version.firstNight) : null,
      lastNight: version.lastNight ? toNight(version.lastNight) : null,
      partySize: version.partySize,
      groundFloorNeeded: version.groundFloorNeeded,
      accessibleRoomNeeded: version.accessibleRoomNeeded,
      privateRoomRequested: version.privateRoomRequested,
      householdPreference: version.householdPreference,
      source: version.source,
      afterDeadline: version.afterDeadline,
      createdAt: version.createdAt,
    }];
  });
}

/**
 * The one counting rule for a category's free space (slices 2 and 3 share it). For each category C and night N, the
 * people counted are the sum over registrations g of the largest of
 *
 * - `request`: g's active request party, when the request is for C and covers N;
 * - `placed`: the people of g actually placed in units of C on N (an expected guest or an assignment with no registration
 *   is its own group and has only this term, with its headcount);
 * - `waiting`: the party of g's live offers (OFFERED, not expired) and accepted entries for C covering N.
 *
 * Only active registrations count requests and entries; a placement counts until staff release it. Taking the largest of
 * the three means a person who asked, was offered and was placed in one category is counted once, while a placement in
 * another category, more people than asked, nights outside the request, or a larger entry are all still counted. It is
 * deliberately conservative: a registration promoted into another category holds both its request and its placement
 * until staff update the request. A registration is left out by name (the one being checked stands in for itself).
 * Free space is `categoryFits({ capacity, demand })` on the result.
 *
 * `countsTowardPublicCapacity` is the single place to leave a kind of registration out of public capacity later (for
 * example staff-invite registrations, #804): return false for the registrations that should not count.
 */
type DemandTerms = { request: number; placed: number; waiting: number };
/** Per group (a registration, or one expected-guest row), category and night: the three terms of the counting rule. */
export type DemandGroups = Map<string, Map<LodgingCategory, Map<string, DemandTerms>>>;

function termsFor(groups: DemandGroups, group: string, category: LodgingCategory, night: string) {
  const byCategory = groups.get(group) ?? new Map<LodgingCategory, Map<string, DemandTerms>>();
  groups.set(group, byCategory);
  const byNight = byCategory.get(category) ?? new Map<string, DemandTerms>();
  byCategory.set(category, byNight);
  const terms = byNight.get(night) ?? { request: 0, placed: 0, waiting: 0 };
  byNight.set(night, terms);
  return terms;
}

/** Adds a live offer's people to a registration's group (so the next entry of a batch counts it). */
export function addWaitingDemand(groups: DemandGroups, registrationId: string, category: LodgingCategory, entryNights: readonly string[], partySize: number) {
  for (const night of entryNights) termsFor(groups, registrationId, category, night).waiting += partySize;
}

/** Loads every group's terms once, for the nights given (nobody left out). */
export async function loadDemandGroups(
  client: Client,
  eventId: string,
  nights: readonly string[],
  options: { now?: Date; countsTowardPublicCapacity?: (registrationId: string) => boolean } = {},
): Promise<DemandGroups> {
  const now = options.now ?? new Date();
  const counts = options.countsTowardPublicCapacity ?? (() => true);
  const groups: DemandGroups = new Map();
  const inWindow = (list: readonly string[]) => list.filter((night) => nights.includes(night));
  const requests = await loadCurrentRequests(client, eventId, { registration: { status: { in: [...lodgingActiveRegistrationStatuses] } } });
  for (const row of requests) {
    if (!row.category || !counts(row.registrationId)) continue;
    for (const night of inWindow(requestNights(row, nights))) termsFor(groups, row.registrationId, row.category, night).request += row.partySize;
  }
  // People placed in a unit, by the registration they belong to (an expected guest or an unlinked row is its own group).
  const placed = await client.eventLodgingAssignment.findMany({
    where: { eventId, cancelledAt: null, eventLodgingUnitId: { not: null } },
    select: { id: true, people: true, firstNight: true, lastNight: true, eventUnit: { select: { unit: { select: { category: true } } } }, attendee: { select: { registrationId: true } } },
  });
  for (const row of placed) {
    const category = row.eventUnit?.unit.category;
    if (!category) continue;
    const owner = row.attendee?.registrationId ?? null;
    if (owner !== null && !counts(owner)) continue;
    for (const night of inWindow(nightsInclusive(toNight(row.firstNight), toNight(row.lastNight)))) termsFor(groups, owner ?? `row:${row.id}`, category, night).placed += row.people;
  }
  // Live offers and accepted entries of active registrations.
  const entries = await client.eventLodgingWaitlistEntry.findMany({
    where: { eventId, status: { in: ["OFFERED", "ACCEPTED"] }, registration: { status: { in: [...lodgingActiveRegistrationStatuses] } } },
  });
  for (const entry of entries) {
    if (isOfferLapsed({ status: entry.status as "OFFERED" | "ACCEPTED", offerExpiresAt: entry.offerExpiresAt } as Parameters<typeof isOfferLapsed>[0], now)) continue;
    if (!counts(entry.registrationId)) continue;
    const entryNights = entry.firstNight && entry.lastNight ? nightsInclusive(toNight(entry.firstNight), toNight(entry.lastNight)) : [...nights];
    addWaitingDemand(groups, entry.registrationId, entry.category, inWindow(entryNights), entry.partySize);
  }
  return groups;
}

/** The people counted per category and night, leaving one registration's group out. */
export function demandFromGroups(groups: DemandGroups, excludeRegistrationId: string | null = null) {
  const demand = new Map<LodgingCategory, Map<string, number>>();
  for (const [group, byCategory] of groups) {
    if (group === excludeRegistrationId) continue;
    for (const [category, byNight] of byCategory) {
      const total = demand.get(category) ?? new Map<string, number>();
      for (const [night, terms] of byNight) total.set(night, (total.get(night) ?? 0) + Math.max(terms.request, terms.placed, terms.waiting));
      demand.set(category, total);
    }
  }
  return demand;
}

export async function demandExcluding(
  client: Client,
  eventId: string,
  nights: readonly string[],
  registrationId: string,
  options: { now?: Date; countsTowardPublicCapacity?: (registrationId: string) => boolean } = {},
) {
  return demandFromGroups(await loadDemandGroups(client, eventId, nights, options), registrationId);
}

export function attendeeName(attendee: { profileSnapshot: unknown; person: { firstName: string; lastName: string } }) {
  const profile = record(attendee.profileSnapshot);
  const first = typeof profile.firstName === "string" ? profile.firstName : attendee.person.firstName;
  const last = typeof profile.lastName === "string" ? profile.lastName : attendee.person.lastName;
  return `${first} ${last}`.trim() || "Attendee";
}

async function loadRegistration(tx: Client, eventId: string, registrationId: string) {
  const registration = await tx.registration.findFirst({
    where: { id: registrationId, eventId },
    select: {
      id: true,
      status: true,
      confirmationCode: true,
      clubRegistration: { select: { id: true } },
      groupRegistration: { select: { id: true } },
      accountHolderPerson: { select: { firstName: true, lastName: true } },
      attendees: { orderBy: [{ position: "asc" }, { id: "asc" }], select: { personId: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!registration) throw new LodgingError("REGISTRATION_NOT_FOUND", "That registration was not found for this event.");
  // Club and group registrations have rosters their directors place; guests do not choose lodging for them.
  if (registration.clubRegistration || registration.groupRegistration) {
    throw new LodgingError("REGISTRATION_NOT_ELIGIBLE", "Lodging requests are for individual registrations. Club and group lodging is assigned by staff.");
  }
  return {
    ...registration,
    people: registration.attendees.map((attendee) => ({ personId: attendee.personId, name: attendeeName(attendee) })),
  };
}

function assertActiveRegistration(status: string) {
  if (!(lodgingActiveRegistrationStatuses as readonly string[]).includes(status)) {
    throw new LodgingError("REGISTRATION_NOT_ACTIVE", "Lodging can be requested only on a submitted or confirmed registration.");
  }
}

// ---------------------------------------------------------------------------
// Event settings
// ---------------------------------------------------------------------------

export async function updateLodgingSettings(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = lodgingSettingsSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const before = await tx.eventLodging.findUnique({ where: { eventId } });
    if (!before) throw new LodgingError("NO_PROPERTY", "Choose a lodging property for this event first.");
    const updated = await tx.eventLodging.update({
      where: { id: before.id },
      data: {
        ...(input.collectsPreferences !== undefined ? { collectsPreferences: input.collectsPreferences } : {}),
        ...(input.preferencesDeadline !== undefined ? { preferencesDeadline: input.preferencesDeadline ? toDate(input.preferencesDeadline) : null } : {}),
        ...(input.fullBehavior !== undefined ? { fullBehavior: input.fullBehavior } : {}),
        settingsUpdatedByUserId: actorUserId,
      },
    });
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_SETTINGS_CHANGED", entityType: "EventLodging", entityId: before.id,
      summary: "Changed the lodging preference settings.",
      metadata: {
        collectsPreferences: { from: before.collectsPreferences, to: updated.collectsPreferences },
        preferencesDeadline: { from: before.preferencesDeadline ? toNight(before.preferencesDeadline) : null, to: updated.preferencesDeadline ? toNight(updated.preferencesDeadline) : null },
        fullBehavior: { from: before.fullBehavior, to: updated.fullBehavior },
      },
    }, tx);
    return { collectsPreferences: updated.collectsPreferences, preferencesDeadline: updated.preferencesDeadline ? toNight(updated.preferencesDeadline) : null, fullBehavior: updated.fullBehavior };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Saving a request: every change is a new, immutable version
// ---------------------------------------------------------------------------

export type SaveRequestResult =
  | {
      requestId: string;
      version: number;
      changed: boolean;
      afterDeadline: boolean;
      changeRequested?: false;
      /** A staff change that alters the lodging charge: the registration's total is NOT changed; staff adjust it in Payments. */
      priceNeedsReview?: boolean;
      /** The change in what the request costs at today's rates (signed cents), when `priceNeedsReview`. */
      chargeDeltaCents?: number;
    }
  /** The event's edit policy kept the change from applying itself; it waits in the staff review queue. */
  | { changeRequested: true; changeRequestId: string };

/**
 * A registrant (through their private link) or staff saves the lodging request for one registration.
 * A registrant can change it until the deadline and cannot pick a category that is full; staff can change it
 * at any time with a reason (after the deadline the change is flagged for review) and are not stopped by
 * "full" (the review queue then shows the category as over capacity). Staff without VIEW_SENSITIVE_DATA
 * cannot read or set the accessibility flags; their edits carry the existing flags forward.
 *
 * The event's edit policy (as for every private-link edit) applies to the registrant:
 * - VERIFY_EVERY_EDIT: refused with EDIT_POLICY_REQUIRES_VERIFICATION; the screen is read-only.
 * - TIERED: the accessibility flags may be set by the first saved version only; later changes are staff-only
 *   (FLAGS_STAFF_ONLY).
 *
 * **The charge is never changed here.** The lodging line is priced once, when the registration is submitted. Once a
 * registration exists, a registrant's change that would alter the lodging charge (the request at today's rates, before
 * and after) is not applied: it becomes a change request for staff. A staff change is saved, the result says the charge
 * needs adjusting (`priceNeedsReview`), and staff do that through the Payments adjustment flow. Neither touches the
 * registration's total or its pricing snapshot, and nothing creates a payment or a refund. A church-billed event's
 * expected lodging charge is always 0.
 *
 * A registrant is also refused fewer nights than a rate's minimum (BELOW_MINIMUM_NIGHTS); staff may make the exception.
 */
export async function saveLodgingRequest(
  input: { eventId: string; registrationId: string; actor: Actor; raw: unknown; sourceFormVersionId?: string | null; now?: Date },
  client: PrismaClient = getPrisma(),
): Promise<SaveRequestResult> {
  const now = input.now ?? new Date();
  const staff = input.actor.kind === "STAFF";
  const parsed = staff ? staffLodgingRequestSchema.parse(input.raw) : lodgingRequestSchema.parse(input.raw);
  const reason: string | null = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : null;
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-request:${input.registrationId}`}))`;
    const context = await loadContext(tx, input.eventId);
    const registration = await loadRegistration(tx, input.eventId, input.registrationId);
    assertActiveRegistration(registration.status);
    const pastDeadline = isPastLodgingDeadline(context.deadlineDay, now, context.timezone);
    if (!staff) {
      if (context.editPolicy === "VERIFY_EVERY_EDIT") throw verificationRequired();
      if (!context.collectsPreferences) throw new LodgingError("PREFERENCES_NOT_COLLECTED", "This event does not collect lodging preferences from registrants.");
      if (pastDeadline) throw new LodgingError("DEADLINE_PASSED", `The deadline to change lodging was ${context.deadlineDay}. Contact the event team.`);
    }
    if (input.actor.kind === "STAFF" && !input.actor.canSeeSensitive && (parsed.groundFloorNeeded !== undefined || parsed.accessibleRoomNeeded !== undefined)) {
      throw new LodgingError("SENSITIVE_DATA_FORBIDDEN", "Your event role cannot read or change accessibility flags.");
    }
    const previous = (await loadCurrentRequests(tx, input.eventId, { registrationId: input.registrationId }))[0] ?? null;
    if (!staff && previous
      && ((parsed.groundFloorNeeded !== undefined && parsed.groundFloorNeeded !== previous.groundFloorNeeded)
        || (parsed.accessibleRoomNeeded !== undefined && parsed.accessibleRoomNeeded !== previous.accessibleRoomNeeded))) {
      throw new LodgingError("FLAGS_STAFF_ONLY", "Accessibility needs can be set when you first choose lodging. To change them now, contact the event team.");
    }

    const nights = parsed.firstNight && parsed.lastNight ? requestNights({ firstNight: parsed.firstNight, lastNight: parsed.lastNight }, context.nights) : context.nights;
    if (parsed.firstNight && parsed.lastNight && (parsed.firstNight < context.nights[0]! || parsed.lastNight > context.nights[context.nights.length - 1]!)) {
      throw new LodgingError("DATES_OUTSIDE_EVENT", `Choose nights between ${context.nights[0]} and ${context.nights[context.nights.length - 1]}.`);
    }
    if (nights.length === 0) throw new LodgingError("NO_NIGHTS", "This event has no bookable nights.");

    const partySize = parsed.partySize ?? previous?.partySize ?? Math.max(1, registration.people.length);
    if (partySize > Math.max(1, registration.people.length)) {
      throw new LodgingError("PARTY_TOO_LARGE", `This registration has ${registration.people.length} attendee${registration.people.length === 1 ? "" : "s"}. Choose a party that size or smaller.`);
    }

    const next = {
      category: parsed.category,
      firstNight: parsed.firstNight ?? null,
      lastNight: parsed.lastNight ?? null,
      partySize,
      groundFloorNeeded: parsed.groundFloorNeeded ?? previous?.groundFloorNeeded ?? false,
      accessibleRoomNeeded: parsed.accessibleRoomNeeded ?? previous?.accessibleRoomNeeded ?? false,
      privateRoomRequested: parsed.privateRoomRequested ?? previous?.privateRoomRequested ?? false,
      householdPreference: (parsed.householdPreference ?? previous?.householdPreference ?? "TOGETHER") as HouseholdPreference,
    };
    if (previous
      && previous.category === next.category && previous.firstNight === next.firstNight && previous.lastNight === next.lastNight
      && previous.partySize === next.partySize && previous.groundFloorNeeded === next.groundFloorNeeded
      && previous.accessibleRoomNeeded === next.accessibleRoomNeeded && previous.privateRoomRequested === next.privateRoomRequested
      && previous.householdPreference === next.householdPreference) {
      return { requestId: previous.requestId, version: previous.version, changed: false, afterDeadline: previous.afterDeadline };
    }

    const rates = await loadRates(tx, context.eventLodgingId);
    const rate = next.category ? rateForCategory(rates, next.category) : null;
    if (!staff && rate?.minimumNights && nights.length < rate.minimumNights) {
      throw new LodgingError("BELOW_MINIMUM_NIGHTS", `${lodgingCategoryLabels[next.category!]} needs at least ${rate.minimumNights} nights.`);
    }

    // Every unit row of the event's lodging is the lock a selection takes, before any capacity is read, so two
    // registrants racing for the last places cannot both get them (#200 takes the same lock before it assigns).
    // The capacity version is bumped under those locks, so a Serializable submission that read capacity earlier fails
    // and is retried instead of overbooking.
    let capacity: Awaited<ReturnType<typeof loadCategoryCapacity>>["capacity"] = {};
    if (next.category || previous?.category) {
      const everyUnit = await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: context.eventLodgingId }, select: { id: true } });
      await lockEventLodgingUnits(tx, input.eventId, everyUnit.map((row) => row.id));
      if (next.category) await touchEventLodgingCapacity(tx, context.eventLodgingId);
      capacity = (await loadCategoryCapacity(tx, context)).capacity;
    }

    // What the request costs, before and after, at today's rates: a rate change alone, or an edit that does not touch
    // the price, is not a charge change.
    const costOf = (category: LodgingCategory | null, nightCount: number, party: number) => {
      if (context.churchBilled || !category) return 0;
      const charge = lodgingCharge({ category, nights: nightCount, partySize: party, rates, ignoreMinimum: true, units: unitsForParty(party, capacity[category]?.unitCapacity) });
      return charge.kind === "CHARGE" ? charge.line.amountCents : 0;
    };
    const previousCents = previous ? costOf(previous.category, requestNights(previous, context.nights).length, previous.partySize) : 0;
    const nextCents = costOf(next.category, nights.length, partySize);
    const chargeChanges = previousCents !== nextCents;
    if (!staff && chargeChanges) {
      await tx.eventLodgingChangeRequest.updateMany({
        where: { registrationId: input.registrationId, resolvedAt: null },
        data: { resolvedAt: now, resolution: "Superseded by a newer request" },
      });
      const change = await tx.eventLodgingChangeRequest.create({
        data: {
          eventId: input.eventId, registrationId: input.registrationId, category: next.category,
          firstNight: next.firstNight ? toDate(next.firstNight) : null, lastNight: next.lastNight ? toDate(next.lastNight) : null,
          partySize: next.partySize, privateRoomRequested: next.privateRoomRequested, householdPreference: next.householdPreference,
          accessTokenId: input.actor.kind === "REGISTRANT" ? input.actor.accessTokenId : null,
        },
      });
      await writeAuditLog({
        eventId: input.eventId, action: "LODGING_CHANGE_REQUESTED", entityType: "EventLodgingChangeRequest", entityId: change.id,
        summary: `A change that alters the lodging charge was requested on ${registration.confirmationCode}.`,
        metadata: { registrationId: input.registrationId, category: next.category, accessTokenId: change.accessTokenId, deltaCents: nextCents - previousCents },
      }, tx);
      return { changeRequested: true as const, changeRequestId: change.id };
    }

    if (next.category) {
      const categoryCapacity = capacity[next.category];
      if (!categoryCapacity || categoryCapacity.unitsInService === 0) {
        throw new LodgingError("CATEGORY_NOT_OFFERED", `${lodgingCategoryLabels[next.category]} is not available for this event.`);
      }
      // Only a request that asks for more than it replaces needs room: the type, a bigger party, or a new night.
      const grew = requestGrew(previous ? { category: previous.category, partySize: previous.partySize, nights: requestNights(previous, context.nights) } : null, { category: next.category, partySize, nights });
      if (!staff && grew) {
        const demand = (await demandExcluding(tx, input.eventId, context.nights, input.registrationId)).get(next.category);
        const fit = categoryFits({ capacity: categoryCapacity, demand, nights, partySize });
        if (!fit.fits) {
          throw new LodgingError("CATEGORY_FULL", context.fullBehavior === "WAITLIST"
            ? `${lodgingCategoryLabels[next.category]} is full for those nights. A waitlist will open soon; for now choose another type.`
            : `${lodgingCategoryLabels[next.category]} is full for those nights.`);
        }
      }
    }

    const request = previous
      ? await tx.eventLodgingRequest.update({ where: { id: previous.requestId }, data: { currentVersion: previous.version + 1 } })
      : await tx.eventLodgingRequest.create({ data: { eventId: input.eventId, registrationId: input.registrationId, currentVersion: 1 } });
    const version = request.currentVersion;
    await tx.eventLodgingRequestVersion.create({
      data: {
        eventId: input.eventId,
        requestId: request.id,
        version,
        category: next.category,
        firstNight: next.firstNight ? toDate(next.firstNight) : null,
        lastNight: next.lastNight ? toDate(next.lastNight) : null,
        partySize: next.partySize,
        groundFloorNeeded: next.groundFloorNeeded,
        accessibleRoomNeeded: next.accessibleRoomNeeded,
        privateRoomRequested: next.privateRoomRequested,
        householdPreference: next.householdPreference,
        source: staff ? "STAFF" : "REGISTRANT",
        sourceFormVersionId: input.sourceFormVersionId ?? null,
        actorUserId: input.actor.kind === "STAFF" ? input.actor.userId : null,
        accessTokenId: input.actor.kind === "REGISTRANT" ? input.actor.accessTokenId : null,
        changeReason: reason,
        afterDeadline: staff && pastDeadline,
      },
    });
    const changedFields = (["category", "firstNight", "lastNight", "partySize", "privateRoomRequested", "householdPreference"] as const).filter((field) => !previous || previous[field] !== next[field]);
    // Said only when an existing request's flags change; a first request never records whether they were set.
    const accessibilityChanged = previous
      ? previous.groundFloorNeeded !== next.groundFloorNeeded || previous.accessibleRoomNeeded !== next.accessibleRoomNeeded
      : null;
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actor.kind === "STAFF" ? input.actor.userId : undefined,
      action: "LODGING_REQUEST_SAVED",
      entityType: "EventLodgingRequest",
      entityId: request.id,
      summary: `${previous ? "Changed" : "Recorded"} the lodging request for ${registration.confirmationCode}.`,
      // The flags' values are never written to the audit log: only that they changed.
      metadata: {
        registrationId: input.registrationId,
        version,
        source: staff ? "STAFF" : "REGISTRANT",
        category: { from: previous?.category ?? null, to: next.category },
        changedFields,
        ...(accessibilityChanged === null ? {} : { accessibilityChanged }),
        afterDeadline: staff && pastDeadline,
        ...(input.actor.kind === "REGISTRANT" ? { accessTokenId: input.actor.accessTokenId } : {}),
      },
    }, tx);
    if (staff) {
      await tx.eventLodgingChangeRequest.updateMany({
        where: { registrationId: input.registrationId, resolvedAt: null },
        data: { resolvedAt: now, resolvedByUserId: input.actor.kind === "STAFF" ? input.actor.userId : null, resolution: "Handled by staff" },
      });
    }
    return { requestId: request.id, version, changed: true, afterDeadline: staff && pastDeadline, ...(staff && chargeChanges ? { priceNeedsReview: true, chargeDeltaCents: nextCents - previousCents } : {}) };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Roommate requests
// ---------------------------------------------------------------------------

function toRoommateRow(row: { id: string; fromRegistrationId: string; targetRegistrationId: string; fromPersonId: string | null; targetPersonId: string | null; decision: RoommateRow["decision"]; withdrawnAt: Date | null }): RoommateRow {
  return { id: row.id, fromRegistrationId: row.fromRegistrationId, targetRegistrationId: row.targetRegistrationId, fromPersonId: row.fromPersonId, targetPersonId: row.targetPersonId, decision: row.decision, withdrawn: row.withdrawnAt !== null };
}

export type RegistrantRoommateResult = { id: string; created: boolean };

/**
 * Finds the registration a guest named by name and confirmation code together. Every miss (wrong code, wrong name,
 * cancelled, other event, club or group) is the same ROOMMATE_NOT_FOUND, so the lookup cannot be used to find out which
 * codes or names exist. A matched attendee is returned as the person; matching only the account holder names the
 * registration as a whole.
 */
export async function findRoommateTarget(tx: Client, eventId: string, name: string, confirmationCode: string) {
  const notFound = new LodgingError("ROOMMATE_NOT_FOUND", "We could not find a registration with that name and confirmation code. Check both and try again.");
  const target = await tx.registration.findFirst({
    where: {
      eventId, confirmationCode: normalizeConfirmationCode(confirmationCode), status: { in: [...lodgingActiveRegistrationStatuses] },
      clubRegistration: { is: null }, groupRegistration: { is: null },
    },
    select: {
      id: true,
      accountHolderPerson: { select: { firstName: true, lastName: true } },
      attendees: { select: { personId: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!target) throw notFound;
  const wanted = normalizeName(name);
  const matched = target.attendees.find((attendee) => normalizeName(attendeeName(attendee)) === wanted);
  const holderMatches = normalizeName(`${target.accountHolderPerson.firstName} ${target.accountHolderPerson.lastName}`) === wanted;
  if (!matched && !holderMatches) throw notFound;
  return { registrationId: target.id, personId: matched?.personId ?? null };
}

type RoommateChangeInput = { eventId: string; registrationId: string; accessTokenId: string; raw: unknown; now?: Date };

/**
 * A registrant asks to room with someone, or takes the request back. Someone on another individual registration is
 * found by name and confirmation code together; any mismatch (wrong code, wrong name, cancelled, other event, club or
 * group) gives the same answer, so this cannot be used to find out which codes or names exist. Someone on the
 * registrant's own registration is picked from their own attendees.
 *
 * The result never carries a contact detail and never says who has asked for this registration. The registrant's view
 * does show a request as "matched" once the other side has asked back (or staff approved), because by then both
 * people named each other. A lookup miss is audited by ids and a running count only (never the typed name or code),
 * outside the failed transaction, so a pattern of guessing is visible to staff. Like every private-link edit it is
 * refused when the event verifies every edit.
 */
export async function changeRegistrantRoommates(input: RoommateChangeInput, client: PrismaClient = getPrisma()): Promise<RegistrantRoommateResult | { withdrawn: true }> {
  try {
    return await changeRegistrantRoommatesInTransaction(input, client);
  } catch (error) {
    const raw = input.raw as { action?: unknown } | null;
    if (error instanceof LodgingError && error.code === "ROOMMATE_NOT_FOUND" && raw && raw.action === "add_by_code") {
      const since = new Date((input.now ?? new Date()).getTime() - 60 * 60 * 1000);
      const recent = await client.auditLog.count({ where: { eventId: input.eventId, action: "LODGING_ROOMMATE_LOOKUP_MISSED", entityId: input.registrationId, createdAt: { gte: since } } });
      await writeAuditLog({
        eventId: input.eventId, action: "LODGING_ROOMMATE_LOOKUP_MISSED", entityType: "Registration", entityId: input.registrationId,
        summary: "A roommate lookup on a registration found no match.",
        metadata: { registrationId: input.registrationId, accessTokenId: input.accessTokenId, missesInTheLastHour: recent + 1 },
      }, client);
    }
    throw error;
  }
}

async function changeRegistrantRoommatesInTransaction(input: RoommateChangeInput, client: PrismaClient): Promise<RegistrantRoommateResult | { withdrawn: true }> {
  const now = input.now ?? new Date();
  const action = registrantRoommateSchema.parse(input.raw);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-roommates:${input.eventId}`}))`;
    const context = await loadContext(tx, input.eventId);
    const own = await loadRegistration(tx, input.eventId, input.registrationId);
    assertActiveRegistration(own.status);
    if (context.editPolicy === "VERIFY_EVERY_EDIT") throw verificationRequired();
    if (!context.collectsPreferences) throw new LodgingError("PREFERENCES_NOT_COLLECTED", "This event does not collect lodging preferences from registrants.");
    if (isPastLodgingDeadline(context.deadlineDay, now, context.timezone)) {
      throw new LodgingError("DEADLINE_PASSED", `The deadline to change lodging was ${context.deadlineDay}. Contact the event team.`);
    }
    if (action.action === "withdraw") {
      const row = await tx.eventLodgingRoommateRequest.findFirst({ where: { id: action.requestId, eventId: input.eventId, fromRegistrationId: input.registrationId } });
      // Another registration's request is indistinguishable from a missing one.
      if (!row) throw new LodgingError("ROOMMATE_NOT_FOUND", "That roommate request was not found.");
      if (!row.withdrawnAt) {
        await tx.eventLodgingRoommateRequest.update({ where: { id: row.id }, data: { withdrawnAt: now, withdrawnByUserId: null, withdrawalReason: "Withdrawn by the registrant" } });
        await writeAuditLog({
          eventId: input.eventId, action: "LODGING_ROOMMATE_WITHDRAWN", entityType: "EventLodgingRoommateRequest", entityId: row.id,
          summary: `Roommate request withdrawn by the registrant on ${own.confirmationCode}.`,
          metadata: { registrationId: input.registrationId, accessTokenId: input.accessTokenId },
        }, tx);
      }
      return { withdrawn: true as const };
    }

    let targetRegistrationId: string;
    let fromPersonId: string | null;
    let targetPersonId: string | null;
    if (action.action === "add_in_registration") {
      if (action.fromPersonId === action.targetPersonId) throw new LodgingError("ROOMMATE_INVALID", "Pick two different people.");
      const members = new Set(own.people.map((person) => person.personId));
      if (!members.has(action.fromPersonId) || !members.has(action.targetPersonId)) {
        throw new LodgingError("ROOMMATE_INVALID", "Both people must be on your registration.");
      }
      targetRegistrationId = input.registrationId;
      fromPersonId = action.fromPersonId;
      targetPersonId = action.targetPersonId;
    } else {
      if (action.fromPersonId && !own.people.some((person) => person.personId === action.fromPersonId)) {
        throw new LodgingError("ROOMMATE_INVALID", "That person is not on your registration.");
      }
      const target = await findRoommateTarget(tx, input.eventId, action.name, action.confirmationCode);
      if (target.registrationId === input.registrationId) {
        throw new LodgingError("ROOMMATE_INVALID", "That is your own registration. Choose \"someone on my registration\" instead.");
      }
      targetRegistrationId = target.registrationId;
      fromPersonId = action.fromPersonId ?? null;
      targetPersonId = target.personId;
    }

    // Asking twice is the same request. The event-wide advisory lock above makes this check-then-create safe, and
    // the partial unique index is the backstop.
    const open = await tx.eventLodgingRoommateRequest.findFirst({
      where: { eventId: input.eventId, fromRegistrationId: input.registrationId, targetRegistrationId, fromPersonId, targetPersonId, withdrawnAt: null },
      select: { id: true },
    });
    if (open) return { id: open.id, created: false };
    const row = await tx.eventLodgingRoommateRequest.create({
      data: {
        eventId: input.eventId,
        fromRegistrationId: input.registrationId,
        targetRegistrationId,
        fromPersonId,
        targetPersonId,
        source: "REGISTRANT",
        accessTokenId: input.accessTokenId,
      },
    });
    await writeAuditLog({
      eventId: input.eventId, action: "LODGING_ROOMMATE_REQUESTED", entityType: "EventLodgingRoommateRequest", entityId: row.id,
      summary: `${own.confirmationCode} asked to room with another registration.`,
      metadata: { fromRegistrationId: input.registrationId, targetRegistrationId, sameRegistration: targetRegistrationId === input.registrationId, accessTokenId: input.accessTokenId },
    }, tx);
    return { id: row.id, created: true };
  }, { timeout: lodgingTransactionTimeoutMs });
}

/** Staff approve (treat as mutual), decline, or withdraw a roommate request, with a reason. */
export async function decideRoommateRequest(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = staffRoommateSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-roommates:${eventId}`}))`;
    const row = await tx.eventLodgingRoommateRequest.findFirst({ where: { id: input.requestId, eventId } });
    if (!row) throw new LodgingError("ROOMMATE_NOT_FOUND", "That roommate request was not found for this event.");
    if (row.withdrawnAt) throw new LodgingError("ROOMMATE_DECIDED", "That request was already withdrawn.");
    const now = new Date();
    if (input.action === "withdraw") {
      await tx.eventLodgingRoommateRequest.update({ where: { id: row.id }, data: { withdrawnAt: now, withdrawnByUserId: actorUserId, withdrawalReason: input.reason } });
    } else {
      if (row.decision !== "PENDING") throw new LodgingError("ROOMMATE_DECIDED", "Staff already decided that request. Withdraw it to start over.");
      if (input.action === "approve") {
        const target = await tx.registration.findFirst({ where: { id: row.targetRegistrationId, eventId }, select: { status: true } });
        if (!target || !(lodgingActiveRegistrationStatuses as readonly string[]).includes(target.status)) {
          throw new LodgingError("REGISTRATION_NOT_ACTIVE", "The requested roommate is no longer registered.");
        }
      }
      await tx.eventLodgingRoommateRequest.update({
        where: { id: row.id },
        data: { decision: input.action === "approve" ? "APPROVED" : "DECLINED", decidedAt: now, decidedByUserId: actorUserId, decisionReason: input.reason },
      });
    }
    await writeAuditLog({
      eventId, actorUserId, action: `LODGING_ROOMMATE_${input.action.toUpperCase()}`, entityType: "EventLodgingRoommateRequest", entityId: row.id,
      summary: `Staff ${input.action === "approve" ? "approved" : input.action === "decline" ? "declined" : "withdrew"} a roommate request.`,
      metadata: { fromRegistrationId: row.fromRegistrationId, targetRegistrationId: row.targetRegistrationId, reason: input.reason },
    }, tx);
    return { id: row.id, action: input.action };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Keep-together, split and keep-apart rules
// ---------------------------------------------------------------------------

export async function createLodgingRule(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = ruleCreateSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-rules:${eventId}`}))`;
    const ids = [input.personAId, ...(input.personBId ? [input.personBId] : [])];
    const found = await tx.registrationAttendee.findMany({ where: { eventId, personId: { in: ids }, registration: { status: { in: [...lodgingActiveRegistrationStatuses] } } }, select: { personId: true } });
    if (new Set(found.map((row) => row.personId)).size !== new Set(ids).size) {
      throw new LodgingError("PERSON_NOT_ON_EVENT", "Every person in a rule must be an attendee on a submitted or confirmed registration for this event.");
    }
    // A pair is stored in id order, so the same two people are one rule whichever way round they were entered.
    const [personAId, personBId] = input.kind === "SPLIT_HOUSEHOLD" ? [input.personAId, null] : [input.personAId, input.personBId!].sort() as [string, string];
    const duplicate = await tx.eventLodgingRule.findFirst({
      where: {
        eventId, kind: input.kind, personAId, personBId, endedAt: null,
        effectiveFrom: input.effectiveFrom ? toDate(input.effectiveFrom) : null,
        effectiveUntil: input.effectiveUntil ? toDate(input.effectiveUntil) : null,
      },
      select: { id: true },
    });
    if (duplicate) throw new LodgingError("RULE_INVALID", "That rule already exists.");
    const rule = await tx.eventLodgingRule.create({
      data: {
        eventId, kind: input.kind, personAId, personBId, reason: input.reason, actorUserId,
        effectiveFrom: input.effectiveFrom ? toDate(input.effectiveFrom) : null,
        effectiveUntil: input.effectiveUntil ? toDate(input.effectiveUntil) : null,
      },
    });
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_RULE_CREATED", entityType: "EventLodgingRule", entityId: rule.id,
      summary: `Added a ${input.kind.toLowerCase().replaceAll("_", " ")} lodging rule.`,
      metadata: { kind: input.kind, personAId, personBId, effectiveFrom: input.effectiveFrom ?? null, effectiveUntil: input.effectiveUntil ?? null, reason: input.reason },
    }, tx);
    return { id: rule.id };
  }, { timeout: lodgingTransactionTimeoutMs });
}

export async function endLodgingRule(eventId: string, actorUserId: string, ruleId: string, reason: string, client: PrismaClient = getPrisma()) {
  const why = reason.trim();
  if (!why) throw new LodgingError("REASON_REQUIRED", "Give a reason.");
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-rules:${eventId}`}))`;
    const rule = await tx.eventLodgingRule.findFirst({ where: { id: ruleId, eventId } });
    if (!rule) throw new LodgingError("RULE_NOT_FOUND", "That rule was not found for this event.");
    if (rule.endedAt) throw new LodgingError("RULE_ENDED", "That rule has already ended.");
    await tx.eventLodgingRule.update({ where: { id: rule.id }, data: { endedAt: new Date(), endedByUserId: actorUserId, endReason: why } });
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_RULE_ENDED", entityType: "EventLodgingRule", entityId: rule.id,
      summary: "Ended a lodging rule.", metadata: { kind: rule.kind, reason: why },
    }, tx);
    return { id: rule.id };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// The staff review queue
// ---------------------------------------------------------------------------

async function loadReviewFacts(client: Client, context: Context) {
  const eventId = context.eventId;
  const [registrations, roommates, rules, authorities, requests, acks, changeRequests, submissions, rates] = await Promise.all([
    client.registration.findMany({
      where: { eventId, status: { not: "DRAFT" }, clubRegistration: { is: null }, groupRegistration: { is: null } },
      select: {
        id: true, status: true, confirmationCode: true,
        waitlistEntry: { select: { status: true } },
        accountHolderPerson: { select: { firstName: true, lastName: true } },
        attendees: { orderBy: [{ position: "asc" }, { id: "asc" }], select: { personId: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { confirmationCode: "asc" },
    }),
    client.eventLodgingRoommateRequest.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
    client.eventLodgingRule.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
    client.guardianAuthority.findMany({ where: { eventId, state: "ACTIVE", adultPersonId: { not: null } }, select: { id: true, minorPersonId: true, adultPersonId: true, declaredAt: true } }),
    loadCurrentRequests(client, eventId),
    client.eventLodgingReviewAck.findMany({ where: { eventId }, select: { itemKey: true, fingerprint: true } }),
    client.eventLodgingChangeRequest.findMany({ where: { eventId, resolvedAt: null }, select: { id: true, registrationId: true, category: true, firstNight: true, lastNight: true, partySize: true }, orderBy: { createdAt: "asc" } }),
    client.publicRegistrationSubmission.findMany({ where: { eventId }, select: { registrationId: true, pricingSnapshot: true } }),
    loadRates(client, context.eventLodgingId),
  ]);
  const { capacity, unitIdsByCategory } = await loadCategoryCapacity(client, context);
  const registrationFacts = new Map<string, RegistrationFact>(registrations.map((registration) => [registration.id, {
    confirmationCode: registration.confirmationCode,
    label: `${registration.confirmationCode} (${registration.accountHolderPerson.firstName} ${registration.accountHolderPerson.lastName})`.replace(/\s+\)/, ")"),
    active: (lodgingActiveRegistrationStatuses as readonly string[]).includes(registration.status),
  }]));
  const people = registrations
    .filter((registration) => registrationFacts.get(registration.id)?.active)
    .flatMap((registration) => registration.attendees.map((attendee) => ({ personId: attendee.personId, registrationId: registration.id, name: attendeeName(attendee) })));
  const ruleRows: Array<RuleRow & { actorUserId: string | null; createdAt: Date }> = rules.map((rule) => ({
    id: rule.id, kind: rule.kind as LodgingRuleKind, personAId: rule.personAId, personBId: rule.personBId,
    effectiveFrom: rule.effectiveFrom ? toNight(rule.effectiveFrom) : null,
    effectiveUntil: rule.effectiveUntil ? toNight(rule.effectiveUntil) : null,
    ended: rule.endedAt !== null, reason: rule.reason, actorUserId: rule.actorUserId, createdAt: rule.createdAt,
  }));
  const guardians: GuardianLink[] = authorities.flatMap((authority) => authority.adultPersonId
    ? [{ authorityId: authority.id, minorPersonId: authority.minorPersonId, adultPersonId: authority.adultPersonId, declaredAt: authority.declaredAt.toISOString() }]
    : []);
  const requestSnapshots: RequestSnapshot[] = requests.map((request) => ({
    requestId: request.requestId, version: request.version, registrationId: request.registrationId,
    category: request.category, firstNight: request.firstNight, lastNight: request.lastNight, partySize: request.partySize,
    groundFloorNeeded: request.groundFloorNeeded, accessibleRoomNeeded: request.accessibleRoomNeeded, privateRoomRequested: request.privateRoomRequested,
    householdPreference: request.householdPreference, afterDeadline: request.afterDeadline, source: request.source, updatedAt: request.createdAt.toISOString(),
  }));
  const roommateRows = roommates.map(toRoommateRow);
  const chargedByRegistration = new Map(submissions.map((submission) => {
    const lines = Array.isArray(record(submission.pricingSnapshot).lineItems) ? (record(submission.pricingSnapshot).lineItems as unknown[]).map(record) : [];
    const stored = lines.find((line) => line.key === LODGING_LINE_KEY);
    return [submission.registrationId, typeof stored?.amountCents === "number" ? stored.amountCents : 0] as const;
  }));
  // What a request costs at today's rates. A church-billed event is never charged lodging through its registrations.
  const costOf = (category: LodgingCategory | null, nightCount: number, party: number) => {
    if (context.churchBilled || !category) return 0;
    const charge = lodgingCharge({ category, nights: nightCount, partySize: party, rates, ignoreMinimum: true, units: unitsForParty(party, capacity[category]?.unitCapacity) });
    return charge.kind === "CHARGE" ? charge.line.amountCents : 0;
  };
  const lodgingCharges = requestSnapshots.map((request) => ({
    registrationId: request.registrationId,
    chargedCents: context.churchBilled ? 0 : chargedByRegistration.get(request.registrationId) ?? 0,
    currentCents: costOf(request.category, requestNights(request, context.nights).length, request.partySize),
  }));
  const changeRequestFacts = changeRequests.map((change) => ({
    id: change.id,
    registrationId: change.registrationId,
    category: change.category,
    chargedCents: context.churchBilled ? 0 : chargedByRegistration.get(change.registrationId) ?? 0,
    requestedCents: costOf(change.category, requestNights({ firstNight: change.firstNight ? toNight(change.firstNight) : null, lastNight: change.lastNight ? toNight(change.lastNight) : null }, context.nights).length, change.partySize),
  }));
  const items = buildReviewItems({ nights: context.nights, registrations: registrationFacts, people, requests: requestSnapshots, roommates: roommateRows, rules: ruleRows, guardians, capacity, changeRequests: changeRequestFacts, lodgingCharges, promotedRegistrationIds: registrations.filter((registration) => registration.waitlistEntry?.status === "PROMOTED").map((registration) => registration.id) });
  const acked = new Set(acks.map((ack) => `${ack.itemKey}\u0000${ack.fingerprint}`));
  return { registrations, registrationFacts, people, requestSnapshots, roommates, roommateRows, ruleRows, guardians, capacity, unitIdsByCategory, items, acked };
}

function visibleItems(items: readonly ReviewItem[], canSeeSensitive: boolean) {
  return items.filter((item) => canSeeSensitive || !item.sensitive);
}

export async function acknowledgeReviewItem(eventId: string, actor: { userId: string; canSeeSensitive: boolean }, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = ruleActionSchema.parse(rawInput);
  if (input.action !== "acknowledge") throw new LodgingError("ITEM_NOT_FOUND", "Not an acknowledgement.");
  return client.$transaction(async (tx) => {
    const context = await loadContext(tx, eventId);
    const facts = await loadReviewFacts(tx, context);
    const item = visibleItems(facts.items, actor.canSeeSensitive).find((candidate) => candidate.key === input.itemKey && candidate.fingerprint === input.fingerprint);
    if (!item) throw new LodgingError("ITEM_NOT_FOUND", "That item has changed or is no longer in the queue. Refresh and look again.");
    // skipDuplicates: acknowledging the same item twice must not abort the transaction.
    const created = await tx.eventLodgingReviewAck.createMany({
      // A restricted (accessibility) item stores no typed note: nothing free-text may sit beside a guest's flags.
      data: [{ eventId, itemKey: item.key, fingerprint: item.fingerprint, note: item.sensitive ? "Acknowledged (restricted item)" : input.note, actorUserId: actor.userId }],
      skipDuplicates: true,
    });
    if (created.count === 0) return { itemKey: item.key, alreadyAcknowledged: true };
    await writeAuditLog({
      eventId, actorUserId: actor.userId, action: "LODGING_REVIEW_ACKNOWLEDGED", entityType: "EventLodgingReviewAck", entityId: item.sensitive ? undefined : item.key,
      summary: item.sensitive ? "Acknowledged a lodging review item." : `Acknowledged a lodging review item (${item.kind.toLowerCase().replaceAll("_", " ")}).`,
      metadata: item.sensitive ? { restricted: true } : { kind: item.kind, itemKey: item.key, note: input.note },
    }, tx);
    return { itemKey: item.key, alreadyAcknowledged: false };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// The staff view
// ---------------------------------------------------------------------------

export type StaffLodgingRequestView = {
  requestId: string;
  registrationId: string;
  registration: string;
  version: number;
  versionCount: number;
  category: LodgingCategory | null;
  firstNight: string | null;
  lastNight: string | null;
  partySize: number;
  privateRoomRequested: boolean;
  householdPreference: HouseholdPreference;
  source: LodgingRequestSource;
  afterDeadline: boolean;
  updatedAt: string;
  /** Present only for staff with VIEW_SENSITIVE_DATA. */
  groundFloorNeeded?: boolean;
  accessibleRoomNeeded?: boolean;
  roommates: Array<{ id: string; direction: "OUT" | "IN"; other: string; status: RoommateStatus["status"]; basis: string | null; decision: string; fromPerson: string | null; targetPerson: string | null }>;
  history: Array<{ version: number; at: string; source: LodgingRequestSource; category: LodgingCategory | null; reason: string | null; afterDeadline: boolean }>;
};

export type StaffLodgingRequestsView = {
  eventId: string;
  settings: { collectsPreferences: boolean; preferencesDeadline: string | null; effectiveDeadline: string; deadlinePassed: boolean; fullBehavior: FullBehavior };
  nights: string[];
  offered: Array<{ category: LodgingCategory; label: string; unitsInService: number; requested: number; rate: LodgingRate | null }>;
  requests: StaffLodgingRequestView[];
  queue: Array<ReviewItem & { acknowledged: boolean }>;
  rules: Array<{ id: string; kind: LodgingRuleKind; personA: string; personB: string | null; reason: string; effectiveFrom: string | null; effectiveUntil: string | null; createdAt: string; ended: boolean; endReason: string | null; actorUserId: string | null }>;
  derivedGroups: Array<{ source: "RESPONSIBLE_ADULT"; minor: string; adult: string; since: string }>;
  people: Array<{ personId: string; name: string; registration: string }>;
  canSeeSensitive: boolean;
};

export async function getStaffLodgingRequestsView(eventId: string, options: { canSeeSensitive: boolean; now?: Date }, client: PrismaClient = getPrisma()): Promise<StaffLodgingRequestsView> {
  const now = options.now ?? new Date();
  const context = await loadContext(client, eventId);
  const facts = await loadReviewFacts(client, context);
  const [rates, versions, ruleEnds] = await Promise.all([
    loadRates(client, context.eventLodgingId),
    client.eventLodgingRequestVersion.findMany({ where: { eventId }, orderBy: [{ requestId: "asc" }, { version: "asc" }] }),
    client.eventLodgingRule.findMany({ where: { eventId }, select: { id: true, endReason: true } }),
  ]);
  const label = (registrationId: string) => facts.registrationFacts.get(registrationId)?.label ?? "Unknown registration";
  const personName = new Map(facts.people.map((person) => [person.personId, person.name]));
  const personLabel = (personId: string | null) => (personId ? personName.get(personId) ?? "Someone no longer registered" : null);
  // Staff who may not read accessibility flags must not be able to infer them from the history: a version that changed
  // only the flags is left out, and a change reason (free text, which may mention them) is not shown.
  const history = new Map<string, StaffLodgingRequestView["history"]>();
  const lastShown = new Map<string, typeof versions[number]>();
  for (const version of versions) {
    const before = lastShown.get(version.requestId);
    const sameButFlags = before !== undefined
      && before.category === version.category && before.partySize === version.partySize
      && before.firstNight?.getTime() === version.firstNight?.getTime() && before.lastNight?.getTime() === version.lastNight?.getTime()
      && before.privateRoomRequested === version.privateRoomRequested && before.householdPreference === version.householdPreference
      && !version.afterDeadline;
    if (!options.canSeeSensitive && sameButFlags) continue;
    lastShown.set(version.requestId, version);
    const list = history.get(version.requestId) ?? [];
    list.push({ version: list.length + 1, at: version.createdAt.toISOString(), source: version.source, category: version.category, reason: options.canSeeSensitive ? version.changeReason : null, afterDeadline: version.afterDeadline });
    history.set(version.requestId, list);
  }
  const requests: StaffLodgingRequestView[] = facts.requestSnapshots
    .filter((request) => facts.registrationFacts.get(request.registrationId)?.active)
    .map((request) => ({
      requestId: request.requestId,
      registrationId: request.registrationId,
      registration: label(request.registrationId),
      version: options.canSeeSensitive ? request.version : history.get(request.requestId)?.length ?? request.version,
      versionCount: history.get(request.requestId)?.length ?? request.version,
      category: request.category,
      firstNight: request.firstNight,
      lastNight: request.lastNight,
      partySize: request.partySize,
      privateRoomRequested: request.privateRoomRequested,
      householdPreference: request.householdPreference,
      source: request.source,
      afterDeadline: request.afterDeadline,
      updatedAt: options.canSeeSensitive ? request.updatedAt : history.get(request.requestId)?.at(-1)?.at ?? request.updatedAt,
      ...(options.canSeeSensitive ? { groundFloorNeeded: request.groundFloorNeeded, accessibleRoomNeeded: request.accessibleRoomNeeded } : {}),
      roommates: facts.roommateRows
        .filter((row) => !row.withdrawn && (row.fromRegistrationId === request.registrationId || row.targetRegistrationId === request.registrationId))
        .map((row) => {
          const standing = roommateStatus(row, facts.roommateRows);
          const outgoing = row.fromRegistrationId === request.registrationId;
          return {
            id: row.id,
            direction: outgoing ? "OUT" as const : "IN" as const,
            other: label(outgoing ? row.targetRegistrationId : row.fromRegistrationId),
            status: standing.status,
            basis: standing.status === "MUTUAL" ? standing.basis : null,
            decision: row.decision,
            fromPerson: personLabel(row.fromPersonId),
            targetPerson: personLabel(row.targetPersonId),
          };
        }),
      history: (history.get(request.requestId) ?? []).map((entry) => entry),
    }));
  const offered = (Object.keys(facts.capacity) as LodgingCategory[])
    .filter((category) => (facts.capacity[category]?.unitsInService ?? 0) > 0)
    .map((category) => ({
      category,
      label: lodgingCategoryLabels[category],
      unitsInService: facts.capacity[category]!.unitsInService,
      requested: requests.filter((request) => request.category === category).reduce((total, request) => total + request.partySize, 0),
      rate: rateForCategory(rates, category),
    }));
  const queue = visibleItems(facts.items, options.canSeeSensitive).map((item) => ({ ...item, acknowledged: facts.acked.has(`${item.key}\u0000${item.fingerprint}`) }));
  const endReasons = new Map(ruleEnds.map((row) => [row.id, row.endReason]));
  return {
    eventId,
    settings: {
      collectsPreferences: context.collectsPreferences,
      preferencesDeadline: context.preferencesDeadline,
      effectiveDeadline: context.deadlineDay,
      deadlinePassed: isPastLodgingDeadline(context.deadlineDay, now, context.timezone),
      fullBehavior: context.fullBehavior,
    },
    nights: context.nights,
    offered,
    requests,
    queue,
    rules: facts.ruleRows.map((rule) => ({
      id: rule.id, kind: rule.kind, personA: personLabel(rule.personAId) ?? "Someone no longer registered", personB: personLabel(rule.personBId),
      reason: rule.reason ?? "", effectiveFrom: rule.effectiveFrom, effectiveUntil: rule.effectiveUntil, createdAt: rule.createdAt.toISOString(),
      ended: rule.ended, endReason: endReasons.get(rule.id) ?? null, actorUserId: rule.actorUserId,
    })),
    derivedGroups: facts.guardians
      .filter((link) => personName.has(link.minorPersonId) && personName.has(link.adultPersonId))
      .map((link) => ({ source: "RESPONSIBLE_ADULT" as const, minor: personName.get(link.minorPersonId)!, adult: personName.get(link.adultPersonId)!, since: link.declaredAt })),
    people: facts.people.map((person) => ({ personId: person.personId, name: person.name, registration: label(person.registrationId) })),
    canSeeSensitive: options.canSeeSensitive,
  };
}

// ---------------------------------------------------------------------------
// The registrant view (through the private registration link)
// ---------------------------------------------------------------------------

export type RegistrantLodgingView = {
  enabled: boolean;
  canEdit: boolean;
  /** Why editing is closed: nothing to show when open. */
  closedReason: "NOT_COLLECTED" | "DEADLINE_PASSED" | "REGISTRATION_NOT_ACTIVE" | "VERIFICATION_REQUIRED" | null;
  /** TIERED events: accessibility needs can be set once; later changes go through the event team. */
  flagsLocked: boolean;
  /** Once registered, a change that alters the lodging charge goes to the event team instead of applying (never on a church-billed event). */
  pricedChangeNeedsStaff: boolean;
  /** A change the registrant asked for that is waiting for the event team. */
  changeRequested: boolean;
  deadline: string;
  fullBehavior: FullBehavior;
  nights: string[];
  offered: Array<{ category: LodgingCategory; label: string; full: boolean; rate: LodgingRate | null; /** People a typical room takes; the per-room charge divides the party by it. */ unitCapacity: number | null }>;
  people: Array<{ personId: string; name: string }>;
  request: {
    version: number;
    category: LodgingCategory | null;
    firstNight: string | null;
    lastNight: string | null;
    partySize: number;
    groundFloorNeeded: boolean;
    accessibleRoomNeeded: boolean;
    privateRoomRequested: boolean;
    householdPreference: HouseholdPreference;
    updatedAt: string;
  } | null;
  earlierVersions: number;
  /** The registrant's own outgoing requests only. Never who asked for them, never a contact detail. */
  roommates: Array<{ id: string; who: string; status: "MATCHED" | "WAITING" | "NOT_MATCHED"; withinRegistration: boolean }>;
};

const emptyView = (overrides: Partial<RegistrantLodgingView>): RegistrantLodgingView => ({
  enabled: false, canEdit: false, closedReason: "NOT_COLLECTED", flagsLocked: false, pricedChangeNeedsStaff: false, changeRequested: false, deadline: "", fullBehavior: "SHOW_FULL", nights: [], offered: [], people: [], request: null, earlierVersions: 0, roommates: [], ...overrides,
});

export async function getRegistrantLodgingView(input: { eventId: string; registrationId: string; now?: Date }, client: PrismaClient = getPrisma()): Promise<RegistrantLodgingView> {
  const now = input.now ?? new Date();
  const lodging = await client.eventLodging.findUnique({ where: { eventId: input.eventId }, select: { collectsPreferences: true } });
  if (!lodging || !lodging.collectsPreferences) return emptyView({});
  const context = await loadContext(client, input.eventId);
  const own = await loadRegistration(client, input.eventId, input.registrationId).catch((error: unknown) => {
    if (error instanceof LodgingError && error.code === "REGISTRATION_NOT_ELIGIBLE") return null;
    throw error;
  });
  if (!own) return emptyView({});
  const { capacity } = await loadCategoryCapacity(client, context);
  const [requests, rates, roommateRows, versionCount, openChanges] = await Promise.all([
    loadCurrentRequests(client, input.eventId, { registrationId: input.registrationId }),
    loadRates(client, context.eventLodgingId),
    client.eventLodgingRoommateRequest.findMany({
      where: { eventId: input.eventId, OR: [{ fromRegistrationId: input.registrationId }, { targetRegistrationId: input.registrationId }] },
    }),
    client.eventLodgingRequestVersion.count({ where: { eventId: input.eventId, request: { registrationId: input.registrationId } } }),
    client.eventLodgingChangeRequest.count({ where: { registrationId: input.registrationId, resolvedAt: null } }),
  ]);
  const current = requests[0] ?? null;
  const demand = demandByCategoryNight((await loadCurrentRequests(client, input.eventId, {
    registrationId: { not: input.registrationId },
    registration: { status: { in: [...lodgingActiveRegistrationStatuses] } },
  })).map((row) => ({ registrationId: row.registrationId, category: row.category, nights: requestNights(row, context.nights), partySize: row.partySize })));
  const partySize = current?.partySize ?? Math.max(1, own.people.length);
  const stayNights = current ? requestNights(current, context.nights) : context.nights;
  const offered = (Object.keys(capacity) as LodgingCategory[])
    .filter((category) => (capacity[category]?.unitsInService ?? 0) > 0)
    .map((category) => ({
      category,
      label: lodgingCategoryLabels[category],
      full: !categoryFits({ capacity: capacity[category]!, demand: demand.get(category), nights: stayNights, partySize }).fits,
      // A church-billed registrant is never shown a price.
      rate: context.churchBilled ? null : rateForCategory(rates, category),
      unitCapacity: capacity[category]?.unitCapacity ?? null,
    }));
  const active = (lodgingActiveRegistrationStatuses as readonly string[]).includes(own.status);
  const pastDeadline = isPastLodgingDeadline(context.deadlineDay, now, context.timezone);
  const closedReason = !active ? "REGISTRATION_NOT_ACTIVE" as const
    : context.editPolicy === "VERIFY_EVERY_EDIT" ? "VERIFICATION_REQUIRED" as const
    : pastDeadline ? "DEADLINE_PASSED" as const : null;

  // Only this registration's own outgoing requests; the other side's requests are visible solely as "matched".
  const allRows = roommateRows.map(toRoommateRow);
  const targetIds = [...new Set(roommateRows.filter((row) => row.fromRegistrationId === input.registrationId).map((row) => row.targetRegistrationId))];
  const targets = targetIds.length > 0
    ? await client.registration.findMany({
        where: { id: { in: targetIds }, eventId: input.eventId },
        select: { id: true, accountHolderPerson: { select: { firstName: true, lastName: true } }, attendees: { select: { personId: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } } } },
      })
    : [];
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const roommates = roommateRows
    .filter((row) => row.fromRegistrationId === input.registrationId && !row.withdrawnAt)
    .map((row) => {
      const target = targetById.get(row.targetRegistrationId);
      const person = target?.attendees.find((attendee) => attendee.personId === row.targetPersonId);
      const who = person ? attendeeName(person) : target ? `${target.accountHolderPerson.firstName} ${target.accountHolderPerson.lastName}`.trim() : "Someone";
      const standing = roommateStatus(toRoommateRow(row), allRows);
      return {
        id: row.id,
        who,
        status: standing.status === "MUTUAL" ? "MATCHED" as const : standing.status === "ONE_SIDED" ? "WAITING" as const : "NOT_MATCHED" as const,
        withinRegistration: row.targetRegistrationId === input.registrationId,
      };
    });
  return {
    enabled: true,
    canEdit: closedReason === null,
    closedReason,
    flagsLocked: current !== null,
    pricedChangeNeedsStaff: !context.churchBilled,
    changeRequested: openChanges > 0,
    deadline: context.deadlineDay,
    fullBehavior: context.fullBehavior,
    nights: context.nights,
    offered,
    people: own.people,
    request: current
      ? {
          version: current.version, category: current.category, firstNight: current.firstNight, lastNight: current.lastNight, partySize: current.partySize,
          groundFloorNeeded: current.groundFloorNeeded, accessibleRoomNeeded: current.accessibleRoomNeeded, privateRoomRequested: current.privateRoomRequested,
          householdPreference: current.householdPreference, updatedAt: current.createdAt.toISOString(),
        }
      : null,
    earlierVersions: Math.max(0, versionCount - (current ? 1 : 0)),
    roommates,
  };
}

// ---------------------------------------------------------------------------
// Export: approved fields only
// ---------------------------------------------------------------------------

export async function getLodgingRequestExportRows(eventId: string, client: PrismaClient = getPrisma()): Promise<LodgingRequestExportRow[]> {
  const context = await loadContext(client, eventId);
  void context;
  const [requests, registrations, roommates] = await Promise.all([
    loadCurrentRequests(client, eventId, { registration: { status: { in: [...lodgingActiveRegistrationStatuses] } } }),
    client.registration.findMany({ where: { eventId, status: { in: [...lodgingActiveRegistrationStatuses] } }, select: { id: true, confirmationCode: true } }),
    client.eventLodgingRoommateRequest.findMany({ where: { eventId } }),
  ]);
  const code = new Map(registrations.map((registration) => [registration.id, registration.confirmationCode]));
  const rows = roommates.map(toRoommateRow);
  return requests
    .map((request) => {
      const outgoing = rows.filter((row) => row.fromRegistrationId === request.registrationId && !row.withdrawn);
      let mutual = 0;
      let waiting = 0;
      for (const row of outgoing) {
        const standing = roommateStatus(row, rows);
        if (standing.status === "MUTUAL") mutual += 1;
        else if (standing.status === "ONE_SIDED") waiting += 1;
      }
      return {
        confirmationCode: code.get(request.registrationId) ?? "",
        category: request.category,
        firstNight: request.firstNight,
        lastNight: request.lastNight,
        partySize: request.partySize,
        privateRoomRequested: request.privateRoomRequested,
        householdPreference: request.householdPreference,
        mutualRoommates: mutual,
        waitingRoommates: waiting,
        updatedAt: request.createdAt.toISOString(),
        groundFloorNeeded: request.groundFloorNeeded,
        accessibleRoomNeeded: request.accessibleRoomNeeded,
      };
    })
    .sort((a, b) => a.confirmationCode.localeCompare(b.confirmationCode));
}
