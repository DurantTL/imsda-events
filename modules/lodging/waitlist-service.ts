import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { lodgingCategoryLabels, nightsInclusive, type LodgingCategory } from "@/modules/lodging/domain";
import {
  assignableRegistrationStatuses,
  isOfferLapsed,
  offerExpiry,
  planPlacements,
  waitlistRegistrantActionSchema,
  waitlistStaffActionSchema,
  type WaitlistStatus,
} from "@/modules/lodging/assignment-domain";
import { finishPlan, resolveOccupants } from "@/modules/lodging/assignment-service";
import { loadPlanningState, toDate, toNight, type PlanningState } from "@/modules/lodging/assignment-state";
import { LodgingError } from "@/modules/lodging/errors";
import { enqueueLodgingMessage, deliverAfterCommit, lodgingRecipient } from "@/modules/lodging/notices";
import { categoryFits, isPastLodgingDeadline } from "@/modules/lodging/preferences-domain";
import { demandExcluding, loadCategoryCapacity, loadContext, type Client, type Tx } from "@/modules/lodging/preferences-service";
import { lockEventLodgingUnits, lodgingTransactionTimeoutMs, touchEventLodgingCapacity } from "@/modules/lodging/service";

/**
 * The lodging waitlist (#200): joined, offered (with an expiry), accepted, declined, expired, removed, promoted.
 *
 * - **Explicit and one at a time.** An offer is a staff action. It previews who would be emailed and queues nothing
 *   until the staff member confirms; a batch is a short, staff-confirmed list. Nothing offers on its own, and a freed
 *   room never promotes anyone by itself.
 * - **Idempotent.** Offering an entry that already holds a live offer returns it without another email; the email's
 *   outbox key is the entry and the offer number, so a repeated click or a retry cannot queue it twice. Accepting,
 *   declining and promoting twice return the first outcome.
 * - **Soft reservation.** A live (unexpired) offer and an accepted entry count against the room that is free in their
 *   category, night by night, so one place cannot be offered twice. Promotion (staff picks a unit) is the placement and
 *   is checked against the real units, under the same locks as every assignment.
 * - **No charge.** Nothing here prices, charges or refunds anything.
 * Every state change appends to the entry's history (and the database insists on it at commit).
 */

const entryInclude = { registration: { select: { confirmationCode: true, status: true, clubRegistration: { select: { id: true } }, groupRegistration: { select: { id: true } } } } } as const;

type EntryRow = Prisma.EventLodgingWaitlistEntryGetPayload<{ include: typeof entryInclude }>;

async function loadEntry(tx: Client, eventId: string, entryId: string) {
  const entry = await tx.eventLodgingWaitlistEntry.findFirst({ where: { id: entryId, eventId }, include: entryInclude });
  if (!entry) throw new LodgingError("WAITLIST_ENTRY_NOT_FOUND", "That waitlist entry was not found.");
  return entry;
}

/**
 * Takes the entry's row lock before it is read, so two answers racing for one entry (a double click, a guest and a
 * staff member) are taken one after the other: the second sees the first's outcome and returns it, with no second
 * history row.
 */
async function lockEntry(tx: Tx, entryId: string) {
  await tx.$queryRaw`SELECT "id" FROM "EventLodgingWaitlistEntry" WHERE "id" = ${entryId} FOR UPDATE`;
}

type Actor = { kind: "STAFF"; userId: string } | { kind: "REGISTRANT"; accessTokenId: string };

async function record(tx: Tx, entry: { id: string; eventId: string }, status: WaitlistStatus, actor: Actor | null, extra: { reason?: string | null; offerNumber: number; offerExpiresAt?: Date | null; messageId?: string | null }, at = new Date()) {
  await tx.eventLodgingWaitlistHistory.create({
    data: {
      eventId: entry.eventId, entryId: entry.id, status, at,
      actorUserId: actor?.kind === "STAFF" ? actor.userId : null,
      accessTokenId: actor?.kind === "REGISTRANT" ? actor.accessTokenId : null,
      reason: extra.reason ?? null, offerNumber: extra.offerNumber, offerExpiresAt: extra.offerExpiresAt ?? null, messageId: extra.messageId ?? null,
    },
  });
}

/** The one-open-entry-per-registration index (a partial unique index): its name, or its column, in the error's target. */
export function isOpenEntryViolation(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const names = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  return names.some((name) => name === "EventLodgingWaitlistEntry_open_key" || name === "registrationId");
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

async function assertIndividualActive(tx: Client, eventId: string, registrationId: string) {
  const registration = await tx.registration.findFirst({
    where: { id: registrationId, eventId },
    select: { status: true, clubRegistration: { select: { id: true } }, groupRegistration: { select: { id: true } } },
  });
  if (!registration) throw new LodgingError("REGISTRATION_NOT_FOUND", "That registration was not found for this event.");
  if (registration.clubRegistration || registration.groupRegistration) {
    throw new LodgingError("REGISTRATION_NOT_ELIGIBLE", "The lodging waitlist is for individual registrations.");
  }
  if (!(assignableRegistrationStatuses as readonly string[]).includes(registration.status)) {
    throw new LodgingError("REGISTRATION_NOT_ACTIVE", "Only a submitted or confirmed registration can join the lodging waitlist.");
  }
}

type JoinInput = { registrationId: string; category: LodgingCategory; firstNight?: string | null; lastNight?: string | null; partySize: number; reason?: string };

async function joinInTransaction(tx: Tx, eventId: string, actor: Actor, input: JoinInput, now: Date) {
  const context = await loadContext(tx, eventId);
  await assertIndividualActive(tx, eventId, input.registrationId);
  const nights = input.firstNight && input.lastNight ? nightsInclusive(input.firstNight, input.lastNight) : [...context.nights];
  if (nights.length === 0 || nights.some((night) => !context.nights.includes(night))) {
    throw new LodgingError("DATES_OUTSIDE_EVENT", `Choose nights between ${context.nights[0]} and ${context.nights[context.nights.length - 1]}.`);
  }
  const { capacity } = await loadCategoryCapacity(tx, context);
  if ((capacity[input.category]?.unitsInService ?? 0) === 0) throw new LodgingError("CATEGORY_NOT_OFFERED", "That lodging type is not offered at this event.");
  if (actor.kind === "REGISTRANT") {
    if (context.fullBehavior !== "WAITLIST") throw new LodgingError("WAITLIST_NOT_ENABLED", "This event does not have a lodging waitlist.");
    if (context.editPolicy === "VERIFY_EVERY_EDIT") throw new LodgingError("EDIT_POLICY_REQUIRES_VERIFICATION", "This event requires verification before this change. To change this, contact the event team.");
    if (isPastLodgingDeadline(context.deadlineDay, now, context.timezone)) throw new LodgingError("DEADLINE_PASSED", "The deadline to change lodging has passed. Contact the event team.");
    const demand = await demandExcluding(tx, eventId, context.nights, input.registrationId, { now });
    const fit = categoryFits({ capacity: capacity[input.category]!, demand: demand.get(input.category), nights, partySize: input.partySize });
    if (fit.fits) throw new LodgingError("CATEGORY_NOT_FULL", "A place is available in that type. Choose it instead of joining the waitlist.");
  }
  try {
    const entry = await tx.eventLodgingWaitlistEntry.create({
      data: {
        eventId, registrationId: input.registrationId, category: input.category,
        firstNight: input.firstNight ? toDate(input.firstNight) : null, lastNight: input.lastNight ? toDate(input.lastNight) : null,
        partySize: input.partySize, createdVia: actor.kind === "STAFF" ? "STAFF" : "REGISTRANT", joinedAt: now,
      },
    });
    await record(tx, entry, "JOINED", actor, { reason: "reason" in input ? input.reason : null, offerNumber: 0 }, now);
    await writeAuditLog({
      eventId, actorUserId: actor.kind === "STAFF" ? actor.userId : undefined, action: "LODGING_WAITLIST_JOINED", entityType: "EventLodgingWaitlistEntry", entityId: entry.id,
      summary: `Joined the lodging waitlist (${lodgingCategoryLabels[input.category]}).`,
      metadata: { category: input.category, partySize: input.partySize, via: actor.kind },
    }, tx);
    return entry;
  } catch (error) {
    if (isOpenEntryViolation(error)) throw new LodgingError("WAITLIST_ALREADY_OPEN", "That registration is already on the lodging waitlist.");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Room for an offer (soft reservation, night by night)
// ---------------------------------------------------------------------------

const nightWords = (first: string | null, last: string | null, all: readonly string[]) => {
  const from = first ?? all[0];
  const to = last ?? all[all.length - 1];
  return from && to ? (from === to ? `the night of ${from}` : `the nights ${from} to ${to}`) : "your nights";
};

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

export type OfferPreviewRow = {
  entryId: string;
  registrationCode: string;
  holder: string;
  category: LodgingCategory;
  partySize: number;
  eligible: boolean;
  /** Why not, or null. */
  reason: string | null;
  /** Already holds a live offer: confirming returns it without sending another email. */
  alreadyOffered: boolean;
  recipientMasked: string | null;
};

export type WaitlistResult =
  | { action: "join"; entryId: string }
  | { action: "offer"; confirmed: false; rows: OfferPreviewRow[] }
  | { action: "offer"; confirmed: true; offered: Array<{ entryId: string; offerNumber: number; expiresAt: string; messageId: string | null; alreadyOffered: boolean }>; skipped: Array<{ entryId: string; reason: string }> }
  | { action: "accept" | "decline" | "remove" | "promote"; entryId: string; status: WaitlistStatus; replay: boolean; assignmentIds?: string[] }
  | { action: "expire_lapsed"; expired: number };

async function lockAll(tx: Tx, eventId: string) {
  const lodging = await tx.eventLodging.findUnique({ where: { eventId }, select: { id: true } });
  if (!lodging) throw new LodgingError("NO_PROPERTY", "Choose a lodging property for this event first.");
  const rows = await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: lodging.id }, select: { id: true } });
  await lockEventLodgingUnits(tx, eventId, rows.map((row) => row.id));
  await touchEventLodgingCapacity(tx, lodging.id);
}

type Reservations = Map<LodgingCategory, Map<string, number>>;

/** Adds an entry's people to the reservations, so a preview of several entries counts each against the next. */
function addReservation(reserved: Reservations, entry: { category: LodgingCategory; partySize: number; firstNight: Date | null; lastNight: Date | null }, eventNights: readonly string[]) {
  const nights = entry.firstNight && entry.lastNight ? nightsInclusive(toNight(entry.firstNight), toNight(entry.lastNight)) : [...eventNights];
  const byNight = reserved.get(entry.category) ?? new Map<string, number>();
  for (const night of nights) byNight.set(night, (byNight.get(night) ?? 0) + entry.partySize);
  reserved.set(entry.category, byNight);
}

async function assessOffer(tx: Client, state: PlanningState, eventId: string, entry: EntryRow, now: Date, previewReserved?: Reservations) {
  const lapsed = isOfferLapsed({ status: entry.status as WaitlistStatus, offerExpiresAt: entry.offerExpiresAt }, now);
  // A live offer whose email failed, was suppressed or was cancelled never reached the guest: it can be offered again.
  let undelivered = false;
  if (entry.status === "OFFERED" && !lapsed && entry.offerMessageId) {
    const sent = await tx.messageOutbox.findUnique({ where: { id: entry.offerMessageId }, select: { status: true } });
    undelivered = Boolean(sent && ["FAILED", "SUPPRESSED", "CANCELLED"].includes(sent.status));
  }
  if (entry.status === "OFFERED" && !lapsed && !undelivered) return { eligible: true, alreadyOffered: true, reason: null as string | null };
  if (!["JOINED", "EXPIRED"].includes(entry.status) && !(entry.status === "OFFERED" && (lapsed || undelivered))) {
    return { eligible: false, alreadyOffered: false, reason: `This entry is ${entry.status.toLowerCase()}, so it cannot be offered a place.` };
  }
  if (!(assignableRegistrationStatuses as readonly string[]).includes(entry.registration.status)) {
    return { eligible: false, alreadyOffered: false, reason: "The registration is no longer submitted or confirmed." };
  }
  const newer = await tx.eventLodgingWaitlistEntry.findFirst({ where: { eventId, registrationId: entry.registrationId, id: { not: entry.id }, status: { in: ["JOINED", "OFFERED", "ACCEPTED"] } }, select: { id: true } });
  if (newer) return { eligible: false, alreadyOffered: false, reason: "That registration has a newer open waitlist entry. Answer or remove it first." };
  // The shared counting rule (requests, unbacked placements, live offers), less this entry's own registration.
  const demand = await demandExcluding(tx, eventId, state.context.nights, entry.registrationId, { now, excludeEntryId: entry.id });
  const byNight = new Map(demand.get(entry.category) ?? []);
  for (const [night, people] of previewReserved?.get(entry.category) ?? []) byNight.set(night, (byNight.get(night) ?? 0) + people);
  const nights = entry.firstNight && entry.lastNight ? nightsInclusive(toNight(entry.firstNight), toNight(entry.lastNight)) : [...state.context.nights];
  const { capacity } = await loadCategoryCapacity(tx, state.context);
  const categoryCapacity = capacity[entry.category];
  const fit = categoryCapacity ? categoryFits({ capacity: categoryCapacity, demand: byNight, nights, partySize: entry.partySize }) : null;
  if (!fit || !fit.fits) return { eligible: false, alreadyOffered: false, reason: `No place is free for ${entry.partySize} ${entry.partySize === 1 ? "person" : "people"} in ${lodgingCategoryLabels[entry.category]} on ${fit?.firstFullNight ?? nights[0]}.` };
  return { eligible: true, alreadyOffered: false, reason: null as string | null };
}

/**
 * Staff waitlist actions. Joining, offering (preview, then confirm), recording an acceptance or decline on a guest's
 * behalf, removing, promoting into a unit, and recording lapsed offers. Offers and promotions require
 * MANAGE_REGISTRATION and CONFIGURE_EVENT (the route checks both); the rest require MANAGE_REGISTRATION.
 */
export async function applyWaitlistAction(eventId: string, actorUserId: string, rawInput: unknown, options: { now?: Date } = {}, client: PrismaClient = getPrisma()): Promise<WaitlistResult> {
  const input = waitlistStaffActionSchema.parse(rawInput);
  const now = options.now ?? new Date();
  const actor: Actor = { kind: "STAFF", userId: actorUserId };
  const deliver: string[] = [];
  const result = await client.$transaction(async (tx): Promise<WaitlistResult> => {
    if (input.action === "join") {
      const entry = await joinInTransaction(tx, eventId, actor, input, now);
      return { action: "join", entryId: entry.id };
    }
    if (input.action === "offer") {
      // The preview only reads: it takes no lock and does not touch the capacity version. Only a confirmed offer does.
      if (input.confirm) await lockAll(tx, eventId);
      const state = await loadPlanningState(tx, eventId);
      // With delivery disabled for the event the email is suppressed and the offer clock would run for nothing.
      const deliveryDisabled = (await tx.eventMessageSettings.findUnique({ where: { eventId }, select: { deliveryMode: true } }))?.deliveryMode === "DISABLED";
      const disabledReason = "Email delivery is disabled for this event, so the guest would never receive the offer. Turn delivery on in the event's communication settings first.";
      const entries: EntryRow[] = [];
      // A confirmed offer takes each entry's row lock (in a fixed order) before it reads the entry, so a guest's answer that
      // committed first is seen here (an ACCEPTED entry is never overwritten) and two offers cannot both write.
      const entryIds = [...new Set(input.entryIds)];
      if (input.confirm) for (const entryId of [...entryIds].sort()) await lockEntry(tx, entryId);
      for (const entryId of entryIds) entries.push(await loadEntry(tx, eventId, entryId));
      if (!input.confirm) {
        const rows: OfferPreviewRow[] = [];
        const previewReserved: Reservations = new Map();
        for (const entry of entries) {
          const assessed = await assessOffer(tx, state, eventId, entry, now, previewReserved);
          if (assessed.eligible && !assessed.alreadyOffered) addReservation(previewReserved, entry, state.context.nights);
          const recipient = await lodgingRecipient(tx, eventId, entry.registrationId);
          rows.push({
            entryId: entry.id, registrationCode: entry.registration.confirmationCode, holder: recipient?.name ?? "", category: entry.category, partySize: entry.partySize,
            eligible: assessed.eligible && Boolean(recipient?.email) && (!deliveryDisabled || assessed.alreadyOffered),
            reason: assessed.reason ?? (!recipient?.email ? "The registration has no email address to send the offer to." : deliveryDisabled && !assessed.alreadyOffered ? disabledReason : null),
            alreadyOffered: assessed.alreadyOffered, recipientMasked: recipient?.email ? `${recipient.email.slice(0, 1)}***@${recipient.email.split("@")[1] ?? ""}` : null,
          });
        }
        return { action: "offer", confirmed: false, rows };
      }
      const offered: Array<{ entryId: string; offerNumber: number; expiresAt: string; messageId: string | null; alreadyOffered: boolean }> = [];
      const skipped: Array<{ entryId: string; reason: string }> = [];
      for (const entry of entries) {
        const assessed = await assessOffer(tx, state, eventId, entry, now);
        if (assessed.alreadyOffered) {
          offered.push({ entryId: entry.id, offerNumber: entry.offerNumber, expiresAt: entry.offerExpiresAt!.toISOString(), messageId: entry.offerMessageId, alreadyOffered: true });
          continue;
        }
        if (!assessed.eligible) { skipped.push({ entryId: entry.id, reason: assessed.reason ?? "Not eligible." }); continue; }
        if (deliveryDisabled) { skipped.push({ entryId: entry.id, reason: disabledReason }); continue; }
        if (entry.status === "OFFERED") {
          const expired = isOfferLapsed({ status: "OFFERED", offerExpiresAt: entry.offerExpiresAt }, now);
          await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: "EXPIRED" } });
          await record(tx, entry, "EXPIRED", expired ? null : actor, { reason: expired ? "The offer expired before it was answered." : "Offered again: the offer email did not reach the guest.", offerNumber: entry.offerNumber, offerExpiresAt: entry.offerExpiresAt }, now);
        }
        const offerNumber = entry.offerNumber + 1;
        const expiresAt = offerExpiry(now, input.expiresInHours);
        const recipient = await lodgingRecipient(tx, eventId, entry.registrationId);
        const message = await enqueueLodgingMessage(tx, {
          eventId, registrationId: entry.registrationId, templateKey: "LODGING_WAITLIST_OFFER",
          subject: `A lodging place may be available: ${recipient?.eventName ?? "the event"}`,
          content: {
            heading: "A lodging place may be available",
            paragraphs: [
              `A place may now be available in ${lodgingCategoryLabels[entry.category]} for ${entry.partySize} ${entry.partySize === 1 ? "person" : "people"} on ${nightWords(entry.firstNight ? toNight(entry.firstNight) : null, entry.lastNight ? toNight(entry.lastNight) : null, state.context.nights)}.`,
              `This offer expires on ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: recipient?.timezone ?? "UTC" }).format(expiresAt)}. After that the place may go to someone else.`,
              "Open your private registration page to accept or decline. Accepting does not charge anything by itself; the event team confirms your room and any charge.",
            ],
            linkLabel: "Open your private registration page",
          },
          idempotencyKey: `lodging-offer:${entry.id}:${offerNumber}`,
          metadata: { waitlistEntryId: entry.id, offerNumber },
        });
        if (message.skipped) { skipped.push({ entryId: entry.id, reason: "The registration has no email address to send the offer to." }); continue; }
        await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: "OFFERED", offerNumber, offeredAt: now, offerExpiresAt: expiresAt, offerMessageId: message.messageId } });
        await record(tx, entry, "OFFERED", actor, { offerNumber, offerExpiresAt: expiresAt, messageId: message.messageId }, now);
        if (message.pending && message.messageId) deliver.push(message.messageId);
        offered.push({ entryId: entry.id, offerNumber, expiresAt: expiresAt.toISOString(), messageId: message.messageId, alreadyOffered: false });
      }
      const fresh = offered.filter((row) => !row.alreadyOffered);
      if (fresh.length > 0) {
        await writeAuditLog({
          eventId, actorUserId, action: "LODGING_WAITLIST_OFFERED", entityType: "EventLodgingWaitlistEntry", entityId: fresh.length === 1 ? fresh[0]!.entryId : undefined,
          summary: `Offered ${fresh.length} lodging waitlist place${fresh.length === 1 ? "" : "s"} (one email each, sent by a staff action).`,
          metadata: { entries: fresh.map((row) => row.entryId), expiresInHours: input.expiresInHours, skipped: skipped.length },
        }, tx);
      }
      return { action: "offer", confirmed: true, offered, skipped };
    }
    if (input.action === "expire_lapsed") {
      const entries = await tx.eventLodgingWaitlistEntry.findMany({ where: { eventId, status: "OFFERED", offerExpiresAt: { lte: now } } });
      for (const entry of entries) {
        await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: "EXPIRED" } });
        await record(tx, entry, "EXPIRED", actor, { reason: "The offer expired before it was answered.", offerNumber: entry.offerNumber, offerExpiresAt: entry.offerExpiresAt }, now);
      }
      if (entries.length > 0) await writeAuditLog({ eventId, actorUserId, action: "LODGING_WAITLIST_EXPIRED", entityType: "EventLodgingWaitlistEntry", summary: `Recorded ${entries.length} lapsed lodging offer(s).`, metadata: { entries: entries.map((entry) => entry.id) } }, tx);
      return { action: "expire_lapsed", expired: entries.length };
    }
    if (input.action === "accept" || input.action === "decline") {
      const outcome = await respond(tx, eventId, input.entryId, actor, input.action, input.reason, now);
      return { action: input.action, entryId: input.entryId, status: outcome.status, replay: outcome.replay };
    }
    if (input.action === "remove") {
      await lockEntry(tx, input.entryId);
      const entry = await loadEntry(tx, eventId, input.entryId);
      if (entry.status === "REMOVED") return { action: "remove", entryId: entry.id, status: "REMOVED", replay: true };
      if (!["JOINED", "OFFERED", "EXPIRED", "ACCEPTED"].includes(entry.status)) throw new LodgingError("WAITLIST_TRANSITION_INVALID", `A ${entry.status.toLowerCase()} entry cannot be removed.`);
      await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: "REMOVED" } });
      await record(tx, entry, "REMOVED", actor, { reason: input.reason, offerNumber: entry.offerNumber }, now);
      await writeAuditLog({ eventId, actorUserId, action: "LODGING_WAITLIST_REMOVED", entityType: "EventLodgingWaitlistEntry", entityId: entry.id, summary: "Removed a registration from the lodging waitlist.", metadata: { from: entry.status } }, tx);
      return { action: "remove", entryId: entry.id, status: "REMOVED", replay: false };
    }
    // promote: place the party in a unit, as a staff decision after the guest accepted.
    await lockAll(tx, eventId);
    const entry = await loadEntry(tx, eventId, input.entryId);
    if (entry.status === "PROMOTED") return { action: "promote", entryId: entry.id, status: "PROMOTED", replay: true };
    if (entry.status !== "ACCEPTED") throw new LodgingError("WAITLIST_TRANSITION_INVALID", "Only an accepted offer can be placed. Offer a place and wait for the guest to accept it.");
    const state = await loadPlanningState(tx, eventId);
    const nights = entry.firstNight && entry.lastNight ? nightsInclusive(toNight(entry.firstNight), toNight(entry.lastNight)) : [...state.context.nights];
    const refs = input.attendeeIds.map((id) => ({ kind: "ATTENDEE" as const, id }));
    const occupants = await resolveOccupants(tx, eventId, refs);
    for (const occupant of occupants.values()) {
      if (occupant.registrationId !== entry.registrationId) throw new LodgingError("OCCUPANT_NOT_FOUND", "Everyone placed from a waitlist entry must be on that entry's registration.");
      if (!(assignableRegistrationStatuses as readonly string[]).includes(occupant.registrationStatus ?? "")) throw new LodgingError("REGISTRATION_NOT_ACTIVE", "That registration is not submitted or confirmed.");
    }
    const planned = planPlacements({
      segments: state.segments, units: state.units, buckets: state.bucketIds, eventNights: state.context.nights,
      placements: input.attendeeIds.map((id) => ({
        occupantKey: id, occupant: { attendeeId: id, placeholderId: null }, people: 1, place: { unitId: input.eventUnitId },
        firstNight: nights[0]!, lastNight: nights[nights.length - 1]!, mode: "ASSIGN" as const, confirmSpecialUse: input.confirmSpecialUse, source: "WAITLIST" as const,
      })),
    });
    if (!planned.ok) throw new LodgingError(planned.problem.code === "UNIT_FULL" ? "UNIT_FULL" : planned.problem.code === "UNIT_OUT_OF_SERVICE" ? "UNIT_OUT_OF_SERVICE" : planned.problem.code === "SPECIAL_USE_UNCONFIRMED" ? "SPECIAL_USE_UNCONFIRMED" : planned.problem.code === "ALREADY_ASSIGNED" ? "ALREADY_ASSIGNED" : "UNKNOWN_PLACE", planned.problem.message);
    const placed = await finishPlan(tx, { eventId, actorUserId, reason: "Placed from the lodging waitlist", source: "WAITLIST", state }, planned.plan, "Placed a lodging waitlist party in a room.", "LODGING_WAITLIST_PROMOTED", { waitlistEntryId: entry.id });
    await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: "PROMOTED" } });
    await record(tx, entry, "PROMOTED", actor, { reason: "Placed in a room by staff", offerNumber: entry.offerNumber }, now);
    return { action: "promote", entryId: entry.id, status: "PROMOTED", replay: false, assignmentIds: placed.assignmentIds };
  }, { timeout: lodgingTransactionTimeoutMs }).catch((error: unknown) => {
    // A race with another open entry for the same registration (the database's one-open-entry rule).
    if (isOpenEntryViolation(error)) throw new LodgingError("WAITLIST_ALREADY_OPEN", "That registration already has another open lodging waitlist entry.");
    throw error;
  });
  await deliverAfterCommit(deliver);
  return result;
}

// ---------------------------------------------------------------------------
// A guest's answer to an offer (also used by staff on their behalf)
// ---------------------------------------------------------------------------

async function respond(tx: Tx, eventId: string, entryId: string, actor: Actor, decision: "accept" | "decline", reason: string | null, now: Date) {
  await lockEntry(tx, entryId);
  const entry = await loadEntry(tx, eventId, entryId);
  const target: WaitlistStatus = decision === "accept" ? "ACCEPTED" : "DECLINED";
  if (entry.status === target) return { status: target, replay: true };
  if (isOfferLapsed({ status: entry.status as WaitlistStatus, offerExpiresAt: entry.offerExpiresAt }, now)) {
    // Record the expiry and leave it recorded: the answer arrived too late.
    await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: "EXPIRED" } });
    await record(tx, entry, "EXPIRED", null, { reason: "The offer expired before it was answered.", offerNumber: entry.offerNumber, offerExpiresAt: entry.offerExpiresAt }, now);
    return { status: "EXPIRED" as WaitlistStatus, replay: false };
  }
  if (entry.status !== "OFFERED") throw new LodgingError("WAITLIST_TRANSITION_INVALID", entry.status === "EXPIRED" ? "That offer has expired." : "There is no open offer to answer.");
  await tx.eventLodgingWaitlistEntry.update({ where: { id: entry.id }, data: { status: target } });
  await record(tx, entry, target, actor, { reason, offerNumber: entry.offerNumber }, now);
  await writeAuditLog({
    eventId, actorUserId: actor.kind === "STAFF" ? actor.userId : undefined, action: decision === "accept" ? "LODGING_WAITLIST_ACCEPTED" : "LODGING_WAITLIST_DECLINED",
    entityType: "EventLodgingWaitlistEntry", entityId: entry.id, summary: decision === "accept" ? "A lodging waitlist offer was accepted." : "A lodging waitlist offer was declined.", metadata: { via: actor.kind },
  }, tx);
  return { status: target, replay: false };
}

export type RegistrantWaitlistView = {
  /** The event offers a lodging waitlist (full behavior is "waitlist"). */
  enabled: boolean;
  entry: null | {
    id: string;
    status: WaitlistStatus;
    category: LodgingCategory;
    firstNight: string | null;
    lastNight: string | null;
    partySize: number;
    offerExpiresAt: string | null;
    lapsed: boolean;
  };
};

export async function getRegistrantWaitlistView(input: { eventId: string; registrationId: string; now?: Date }, client: Client = getPrisma()): Promise<RegistrantWaitlistView> {
  const lodging = await client.eventLodging.findUnique({ where: { eventId: input.eventId }, select: { fullBehavior: true } });
  const entry = await client.eventLodgingWaitlistEntry.findFirst({
    where: { eventId: input.eventId, registrationId: input.registrationId },
    orderBy: { joinedAt: "desc" },
  });
  const now = input.now ?? new Date();
  return {
    enabled: lodging?.fullBehavior === "WAITLIST",
    entry: entry ? {
      id: entry.id, status: entry.status as WaitlistStatus, category: entry.category,
      firstNight: entry.firstNight ? toNight(entry.firstNight) : null, lastNight: entry.lastNight ? toNight(entry.lastNight) : null,
      partySize: entry.partySize, offerExpiresAt: entry.offerExpiresAt?.toISOString() ?? null,
      lapsed: isOfferLapsed({ status: entry.status as WaitlistStatus, offerExpiresAt: entry.offerExpiresAt }, now),
    } : null,
  };
}

/**
 * The guest, through their private link: join when a type is full (events set to waitlist), and accept or decline a
 * live offer. The link names the registration; only that registration's own entry can be touched. An answer after the
 * offer expired records the expiry and changes nothing else.
 */
export async function applyRegistrantWaitlistAction(input: { eventId: string; registrationId: string; accessTokenId: string; raw: unknown; now?: Date }, client: PrismaClient = getPrisma()) {
  const parsed = waitlistRegistrantActionSchema.parse(input.raw);
  const now = input.now ?? new Date();
  const actor: Actor = { kind: "REGISTRANT", accessTokenId: input.accessTokenId };
  return client.$transaction(async (tx) => {
    if (parsed.action === "join") {
      const entry = await joinInTransaction(tx, input.eventId, actor, { registrationId: input.registrationId, ...parsed }, now);
      return { entryId: entry.id, status: "JOINED" as WaitlistStatus, replay: false };
    }
    const entry = await tx.eventLodgingWaitlistEntry.findFirst({
      where: { eventId: input.eventId, registrationId: input.registrationId, status: { in: ["OFFERED", "ACCEPTED", "DECLINED", "EXPIRED"] } },
      orderBy: { joinedAt: "desc" },
    });
    if (!entry) throw new LodgingError("WAITLIST_ENTRY_NOT_FOUND", "There is no lodging offer for this registration.");
    const outcome = await respond(tx, input.eventId, entry.id, actor, parsed.action === "accept" ? "accept" : "decline", null, now);
    return { entryId: entry.id, status: outcome.status, replay: outcome.replay };
  }, { timeout: lodgingTransactionTimeoutMs });
}
