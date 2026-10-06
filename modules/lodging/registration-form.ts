import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { lodgingCategoryLabels, rateForCategory, type LodgingCategory, type LodgingRate } from "@/modules/lodging/domain";
import { LodgingError } from "@/modules/lodging/errors";
import {
  categoryFits,
  requestNights,
  resolveRoomChoice,
  type FullBehavior,
  type HouseholdPreference,
  type RegistrationLodgingInput,
} from "@/modules/lodging/preferences-domain";
import { lodgingCharge, type LodgingPriceLine } from "@/modules/lodging/pricing";
import {
  demandExcluding,
  findRoommateTarget,
  loadCategoryCapacity,
  loadContext,
  loadRates,
  type Tx,
} from "@/modules/lodging/preferences-service";
import { lockEventLodgingUnits, touchEventLodgingCapacity } from "@/modules/lodging/service";

/**
 * The lodging step of the public registration form (#199). It is not a parallel form: it is a step of the registration
 * form, like the responsible-adult choice, whose answers travel beside the form's own (`lodging` in the submission) and
 * are decided on the server inside the registration's own transaction:
 *
 * 1. `planRegistrationLodging` validates the choice against the event's lodging, takes the unit-row locks, refuses a
 *    full type, and prices it; its line goes into the registration's priced total before promo codes and fees.
 * 2. `recordRegistrationLodging` writes the first request version (source REGISTRATION_FORM, with the form version)
 *    and the roommate requests, once the registration and its attendees exist.
 *
 * The locks are held until the registration commits, so two registrants racing for the last places cannot both get
 * them, and a refused submission leaves nothing behind.
 */

export type PublicLodgingOffer = {
  nights: string[];
  /** Last day the registrant may change the choice on the private page afterwards. */
  deadline: string;
  fullBehavior: FullBehavior;
  categories: Array<{
    category: LodgingCategory;
    label: string;
    /** What the type can still take each night, in rooms for a room-type category and people for any other; null is no fixed limit. */
    remaining: Record<string, number | null>;
    rate: LodgingRate | null;
    /** People a typical room takes (the smallest "sleeps up to" among its rooms): the beds the extra-bedding note compares the party with. Null for sites and tents. */
    unitCapacity: number | null;
    /** A room-type category: the registrant chooses how many rooms ("How many rooms?"), and `remaining` counts rooms. */
    roomBased: boolean;
  }>;
};

/** What the form offers, or null when the event does not collect lodging (club events, or no property chosen). */
export async function getPublicLodgingOffer(eventId: string, client: PrismaClient = getPrisma()): Promise<PublicLodgingOffer | null> {
  const row = await client.eventLodging.findUnique({ where: { eventId }, select: { collectsPreferences: true } });
  if (!row?.collectsPreferences) return null;
  const context = await loadContext(client, eventId);
  const [{ capacity }, rates, demand] = await Promise.all([
    loadCategoryCapacity(client, context),
    loadRates(client, context.eventLodgingId),
    demandExcluding(client, eventId, context.nights, "__no_registration__"),
  ]);
  const categories = (Object.keys(capacity) as LodgingCategory[])
    .filter((category) => (capacity[category]?.unitsInService ?? 0) > 0)
    .map((category) => ({
      category,
      label: lodgingCategoryLabels[category],
      remaining: Object.fromEntries(context.nights.map((night) => {
        const limit = capacity[category]!.perNight[night];
        return [night, limit === null || limit === undefined ? null : Math.max(0, limit - (demand.get(category)?.get(night) ?? 0))];
      })),
      // A church-billed registrant is never shown a price.
      rate: context.churchBilled ? null : rateForCategory(rates, category),
      unitCapacity: capacity[category]!.unitCapacity ?? null,
      roomBased: capacity[category]!.roomBased === true,
    }));
  return { nights: context.nights, deadline: context.deadlineDay, fullBehavior: context.fullBehavior, categories };
}

/**
 * The lodging line a promo-code quote should include, so the discount the registrant sees is the one the submission
 * applies. Pricing only: no lock, no capacity check (the submission decides those). Null when there is nothing to price.
 */
export async function lodgingQuoteLine(client: PrismaClient, eventId: string, lodging: RegistrationLodgingInput, attendeeCount: number): Promise<LodgingPriceLine | null> {
  if (!lodging.category) return null;
  const row = await client.eventLodging.findUnique({ where: { eventId }, select: { collectsPreferences: true } });
  if (!row?.collectsPreferences) return null;
  const context = await loadContext(client, eventId);
  if (context.churchBilled) return null;
  const nights = requestNights({ firstNight: lodging.firstNight ?? null, lastNight: lodging.lastNight ?? null }, context.nights).length;
  const partySize = Math.min(lodging.partySize ?? Math.max(1, attendeeCount), Math.max(1, attendeeCount));
  const [{ capacity }, rates] = await Promise.all([loadCategoryCapacity(client, context), loadRates(client, context.eventLodgingId)]);
  // The rooms the registrant chose price the line (a quote never refuses: the submission decides what is allowed).
  const rooms = capacity[lodging.category]?.roomBased ? Math.min(Math.max(1, lodging.roomCount ?? 1), partySize) : 1;
  const charge = lodgingCharge({ category: lodging.category, nights, partySize, rates, units: rooms });
  return charge.kind === "CHARGE" ? charge.line : null;
}

export type LodgingPlan = {
  eventLodgingId: string;
  next: {
    category: LodgingCategory | null;
    firstNight: string | null;
    lastNight: string | null;
    partySize: number;
    /** Rooms chosen (1 unless the category is a room-type one) and the extra-bedding acknowledgement (#803). */
    roomCount: number;
    bringsExtraBedding: boolean;
    groundFloorNeeded: boolean;
    accessibleRoomNeeded: boolean;
    privateRoomRequested: boolean;
    householdPreference: HouseholdPreference;
  };
  nights: string[];
  /** The line to add to the registration total; null when the type has no rate or the event bills a church. */
  line: LodgingPriceLine | null;
};

export async function planRegistrationLodging(
  tx: Tx,
  input: { eventId: string; lodging: RegistrationLodgingInput; attendeeCount: number; priced: boolean; waitlisted?: boolean },
): Promise<LodgingPlan> {
  const row = await tx.eventLodging.findUnique({ where: { eventId: input.eventId }, select: { collectsPreferences: true } });
  if (!row?.collectsPreferences) throw new LodgingError("PREFERENCES_NOT_COLLECTED", "This event does not collect lodging choices.");
  const context = await loadContext(tx, input.eventId);
  const wanted = input.lodging;
  const first = context.nights[0];
  const last = context.nights[context.nights.length - 1];
  if (!first || !last) throw new LodgingError("NO_NIGHTS", "This event has no bookable nights.");
  if (wanted.firstNight && wanted.lastNight && (wanted.firstNight < first || wanted.lastNight > last)) {
    throw new LodgingError("DATES_OUTSIDE_EVENT", `Choose nights between ${first} and ${last}.`);
  }
  const nights = requestNights({ firstNight: wanted.firstNight ?? null, lastNight: wanted.lastNight ?? null }, context.nights);
  const partySize = wanted.partySize ?? Math.max(1, input.attendeeCount);
  if (partySize > Math.max(1, input.attendeeCount)) {
    throw new LodgingError("PARTY_TOO_LARGE", `This registration has ${input.attendeeCount} attendee${input.attendeeCount === 1 ? "" : "s"}. Choose a party that size or smaller.`);
  }
  const next: LodgingPlan["next"] = {
    category: wanted.category,
    firstNight: wanted.firstNight ?? null,
    lastNight: wanted.lastNight ?? null,
    partySize,
    // Settled below, once the category's capacity is known.
    roomCount: 1,
    bringsExtraBedding: false,
    groundFloorNeeded: wanted.groundFloorNeeded ?? false,
    accessibleRoomNeeded: wanted.accessibleRoomNeeded ?? false,
    privateRoomRequested: wanted.privateRoomRequested ?? false,
    householdPreference: wanted.householdPreference ?? "TOGETHER",
  };
  let line: LodgingPriceLine | null = null;
  if (next.category && input.waitlisted) {
    // A registration the server is waitlisting keeps the choice as an unpriced request: no lock, no refusal for a full
    // type (there is no place yet), no charge. The event team confirms it if a place opens.
    const { capacity } = await loadCategoryCapacity(tx, context);
    if (!capacity[next.category] || capacity[next.category]!.unitsInService === 0) {
      throw new LodgingError("CATEGORY_NOT_OFFERED", `${lodgingCategoryLabels[next.category]} is not available for this event.`);
    }
    // The choice is kept as asked (rooms between 1 and the party; extra bedding acknowledged), with no availability check.
    const choice = resolveRoomChoice({ capacity: capacity[next.category], partySize, roomCount: wanted.roomCount, bringsExtraBedding: wanted.bringsExtraBedding, requireAcknowledgement: true });
    if (!choice.ok) throw new LodgingError(choice.code, choice.message);
    next.roomCount = choice.roomCount;
    next.bringsExtraBedding = choice.bringsExtraBedding;
  } else if (next.category) {
    // Every unit row is locked before any capacity is read; the lock is held until this registration commits. Then
    // the capacity version is bumped under the locks: if another writer committed since this Serializable transaction
    // began, the update fails and the submission is retried, so a stale count can never overbook a type.
    const everyUnit = await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: context.eventLodgingId }, select: { id: true } });
    await lockEventLodgingUnits(tx, input.eventId, everyUnit.map((unit) => unit.id));
    await touchEventLodgingCapacity(tx, context.eventLodgingId);
    const { capacity } = await loadCategoryCapacity(tx, context);
    const categoryCapacity = capacity[next.category];
    if (!categoryCapacity || categoryCapacity.unitsInService === 0) {
      throw new LodgingError("CATEGORY_NOT_OFFERED", `${lodgingCategoryLabels[next.category]} is not available for this event.`);
    }
    const demand = (await demandExcluding(tx, input.eventId, context.nights, "__no_registration__")).get(next.category);
    // The rooms chosen, against the rooms free on every night (what a room-type category is counted in); a party larger
    // than the beds in those rooms is allowed once the registrant acknowledges bringing extra bedding.
    const free = categoryFits({ capacity: categoryCapacity, demand, nights, partySize, roomCount: 1 });
    if (!free.fits) {
      throw new LodgingError("CATEGORY_FULL", `${lodgingCategoryLabels[next.category]} is full for those nights. Choose another type or other nights.`);
    }
    const choice = resolveRoomChoice({
      capacity: categoryCapacity, partySize, roomCount: wanted.roomCount, bringsExtraBedding: wanted.bringsExtraBedding, requireAcknowledgement: true,
      roomsAvailable: free.minimumAvailable,
    });
    if (!choice.ok) throw new LodgingError(choice.code, choice.message);
    next.roomCount = choice.roomCount;
    next.bringsExtraBedding = choice.bringsExtraBedding;
    const charge = lodgingCharge({
      category: next.category, nights: nights.length, partySize, rates: await loadRates(tx, context.eventLodgingId),
      units: next.roomCount,
    });
    if (charge.kind === "BELOW_MINIMUM_NIGHTS") {
      throw new LodgingError("BELOW_MINIMUM_NIGHTS", `${lodgingCategoryLabels[next.category]} needs at least ${charge.minimumNights} nights.`);
    }
    if (charge.kind === "CHARGE" && input.priced && !context.churchBilled) line = charge.line;
  }
  return { eventLodgingId: context.eventLodgingId, next, nights, line };
}

/** Writes the first version of the request, and the roommate requests, for the registration just created. */
export async function recordRegistrationLodging(
  tx: Tx,
  input: {
    eventId: string;
    registrationId: string;
    confirmationCode: string;
    formVersionId: string;
    plan: LodgingPlan;
    lodging: RegistrationLodgingInput;
    attendees: ReadonlyArray<{ clientId: string; personId: string }>;
    /** The registration was waitlisted: the request is kept unpriced. */
    waitlisted?: boolean;
  },
) {
  const request = await tx.eventLodgingRequest.create({ data: { eventId: input.eventId, registrationId: input.registrationId, currentVersion: 1 } });
  const next = input.plan.next;
  await tx.eventLodgingRequestVersion.create({
    data: {
      eventId: input.eventId,
      requestId: request.id,
      version: 1,
      category: next.category,
      firstNight: next.firstNight ? new Date(`${next.firstNight}T00:00:00Z`) : null,
      lastNight: next.lastNight ? new Date(`${next.lastNight}T00:00:00Z`) : null,
      partySize: next.partySize,
      roomCount: next.roomCount,
      bringsExtraBedding: next.bringsExtraBedding,
      groundFloorNeeded: next.groundFloorNeeded,
      accessibleRoomNeeded: next.accessibleRoomNeeded,
      privateRoomRequested: next.privateRoomRequested,
      householdPreference: next.householdPreference,
      source: "REGISTRATION_FORM",
      sourceFormVersionId: input.formVersionId,
    },
  });
  const personByClientId = new Map(input.attendees.map((attendee) => [attendee.clientId, attendee.personId]));
  const personFor = (clientId: string | undefined) => {
    if (clientId === undefined) return null;
    const personId = personByClientId.get(clientId);
    if (!personId) throw new LodgingError("ROOMMATE_INVALID", "A roommate request names someone who is not on this registration.");
    return personId;
  };
  const seen = new Set<string>();
  let roommateCount = 0;
  const wantsRoommates = (input.lodging.roommates?.length ?? 0) + (input.lodging.roommatesWithin?.length ?? 0) > 0;
  if (wantsRoommates) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-roommates:${input.eventId}`}))`;
  for (const roommate of input.lodging.roommates ?? []) {
    const target = await findRoommateTarget(tx, input.eventId, roommate.name, roommate.confirmationCode);
    const fromPersonId = personFor(roommate.fromClientId);
    const key = `${target.registrationId}|${fromPersonId ?? ""}|${target.personId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await tx.eventLodgingRoommateRequest.create({
      data: { eventId: input.eventId, fromRegistrationId: input.registrationId, targetRegistrationId: target.registrationId, fromPersonId, targetPersonId: target.personId, source: "REGISTRATION_FORM" },
    });
    roommateCount += 1;
  }
  for (const pair of input.lodging.roommatesWithin ?? []) {
    const fromPersonId = personFor(pair.fromClientId);
    const targetPersonId = personFor(pair.targetClientId);
    if (!fromPersonId || !targetPersonId || fromPersonId === targetPersonId) throw new LodgingError("ROOMMATE_INVALID", "Pick two different people on this registration.");
    const key = `${input.registrationId}|${fromPersonId}|${targetPersonId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await tx.eventLodgingRoommateRequest.create({
      data: { eventId: input.eventId, fromRegistrationId: input.registrationId, targetRegistrationId: input.registrationId, fromPersonId, targetPersonId, source: "REGISTRATION_FORM" },
    });
    roommateCount += 1;
  }
  await writeAuditLog({
    eventId: input.eventId,
    action: "LODGING_REQUEST_SAVED",
    entityType: "EventLodgingRequest",
    entityId: request.id,
    summary: `Recorded the lodging request for ${input.confirmationCode} from the registration form.`,
    // The flags' values are never written to the audit log.
    metadata: {
      registrationId: input.registrationId,
      version: 1,
      source: "REGISTRATION_FORM",
      formVersionId: input.formVersionId,
      category: { from: null, to: next.category },
      roommateRequests: roommateCount,
      chargedCents: input.plan.line?.amountCents ?? 0,
      waitlisted: input.waitlisted === true,
    },
  }, tx);
  return { requestId: request.id, roommateRequests: roommateCount };
}


/**
 * A registration was promoted from the waitlist (or reinstated) while it holds a lodging request. Takes the same unit
 * locks and bumps `capacityVersion` like every other capacity writer, because the request starts counting as demand again.
 * It never blocks or changes the promotion and never charges: the staff review queue lists the request as unconfirmed
 * ("Promoted from the waitlist with an unconfirmed lodging request") when its type no longer fits or it is priced but has no
 * lodging line. Whether it still fits is worked out by the queue (derived from live capacity), not here.
 */
export async function noteLodgingOnAdmission(tx: Tx, eventId: string, registrationId: string) {
  const request = await tx.eventLodgingRequest.findUnique({ where: { eventId_registrationId: { eventId, registrationId } }, select: { id: true } });
  if (!request) return { hasRequest: false as const };
  const eventLodging = await tx.eventLodging.findUnique({ where: { eventId }, select: { id: true } });
  if (!eventLodging) return { hasRequest: true as const };
  const units = await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: eventLodging.id }, select: { id: true } });
  await lockEventLodgingUnits(tx, eventId, units.map((unit) => unit.id));
  await touchEventLodgingCapacity(tx, eventLodging.id);
  return { hasRequest: true as const };
}
