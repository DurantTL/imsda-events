import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { logError } from "@/lib/logger";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { HonorConfigurationError } from "@/modules/honors/repository";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import {
  ClassSelectionError,
  eventPrerequisiteHonorIds,
  getClassSelectionWorkspace,
  liveWaitlistOffer,
  loadMemberRequirements,
  loadOfferings,
  loadRegistration,
  seatHoldingEnrollment,
  type ClassSelectionActor,
  type Snapshot,
} from "@/modules/honors/enrollment-repository";
import {
  consumesClassSeat,
  requirementGaps,
  requirementResolution,
  selectionProblem,
  type RequirementWaivers,
  type SelectableOffering,
} from "@/modules/honors/enrollment-domain";
import { chooseLocationFirstMessage, classChangesClosedMessage, classChangesEnded, classChangesOpen, sessionVisibleAtLocation } from "@/modules/honors/locations";
import {
  holdsConflictingClass,
  offerExpiresAt,
  planOffers,
  placeInLine,
  seatsFree,
  waitingNote,
  waitlistOfferHoursMax,
  waitlistOfferHoursMin,
  type OfferCandidate,
} from "@/modules/honors/waitlist-domain";

/**
 * Honors Weekend class waitlists (#831). A full class has a waitlist of youth in
 * the order their directors added them. When a seat opens, the next youth in
 * line is OFFERED it, the director accepts within the event's window, and an
 * offer that isn't accepted passes to the next youth. See waitlist-domain.ts for
 * the rules and docs/HONORS-WEEKEND-CLASS-WAITLIST.md for the whole picture.
 *
 * Everything that gives out or takes a seat does it inside one serializable
 * transaction that first locks the affected classes (`FOR UPDATE`, in id order),
 * the same lock the seat save takes (#359). A live offer counts with the taken
 * seats, so an offer and a direct pick can never overfill a class.
 *
 * Offers lapse by time. They are enforced when read (a lapsed offer holds no
 * seat and can't be accepted) and written by `sweepClassWaitlists`, which the
 * outbox sweep runs every few minutes, and by every save or cancellation that
 * touches the class.
 */

type Tx = Prisma.TransactionClient;
type ActiveStatus = "SUBMITTED" | "CONFIRMED";
const activeStatuses: ActiveStatus[] = ["SUBMITTED", "CONFIRMED"];

const locationDates = { firstDay: true, lastDay: true, registrationClosesOn: true } satisfies Prisma.EventLocationSelect;

const lifecycleEvent = {
  id: true, name: true, isPublished: true, endsAt: true, timezone: true, registrationOpensOn: true, registrationClosesOn: true,
  waitlistEnabled: true, honorWaitlistOfferHours: true,
} satisfies Prisma.EventSelect;

type LifecycleEvent = Prisma.EventGetPayload<{ select: typeof lifecycleEvent }>;
type LocationDates = { firstDay: string | null; lastDay: string | null; registrationClosesOn: string | null } | null;

function closedMessage(event: LifecycleEvent, location: LocationDates, now: Date) {
  return classChangesClosedMessage(event, location, now);
}

async function lockOfferings(tx: Tx, ids: readonly string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "HonorOffering" WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
}

function nameOf(snapshot: Snapshot) {
  return `${snapshot.firstName ?? ""} ${snapshot.lastName ?? ""}`.trim() || "A youth";
}

type WaitlistActor = ClassSelectionActor | null;

function actorFields(actor: WaitlistActor) {
  return {
    ...(actor && "userId" in actor ? { actorUserId: actor.userId } : {}),
  };
}

function actorMetadata(actor: WaitlistActor) {
  if (!actor) return { system: true };
  return "accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId };
}

// ---------------------------------------------------------------------------
// The offer email: one transactional message to one director, never a bulk send.
// ---------------------------------------------------------------------------

function contactOf(registration: {
  contactSnapshot: unknown;
  accountHolderPerson: { firstName: string; lastName: string; normalizedEmail: string | null };
}) {
  const contact = registration.contactSnapshot && typeof registration.contactSnapshot === "object" && !Array.isArray(registration.contactSnapshot)
    ? registration.contactSnapshot as Record<string, unknown> : {};
  const text = (key: string) => (typeof contact[key] === "string" ? (contact[key] as string).trim() : "");
  const email = (text("email") || registration.accountHolderPerson.normalizedEmail || "").trim().toLowerCase();
  const name = `${text("firstName") || registration.accountHolderPerson.firstName} ${text("lastName") || registration.accountHolderPerson.lastName}`.trim();
  return { email, name };
}

function formatExpiry(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(at);
}

/** Queues the offer email inside the transaction; delivery happens after commit. Returns the outbox id when one is waiting to be sent. */
async function queueOfferEmail(tx: Tx, input: {
  event: LifecycleEvent;
  entryId: string;
  offerCount: number;
  registration: Parameters<typeof contactOf>[0] & { id: string; confirmationCode: string };
  organizationId: string | null;
  className: string;
  sessionName: string | null;
  youthName: string;
  expiresAt: Date;
}) {
  const { email, name } = contactOf(input.registration);
  if (!email) return null;
  const settings = await tx.eventMessageSettings.findUnique({
    where: { eventId: input.event.id },
    select: { deliveryMode: true, senderName: true, senderEmail: true, replyToEmail: true },
  }) ?? { deliveryMode: "LOCAL_CAPTURE" as const, senderName: "IMSDA Events", senderEmail: null, replyToEmail: null };
  const base = getServerEnv().APP_BASE_URL;
  const link = input.organizationId ? `${base}/account/clubs/${input.organizationId}/events/${input.event.id}` : base;
  const where = input.sessionName ? `${input.className} (${input.sessionName})` : input.className;
  const text = [
    `Hello ${name || "there"},`,
    "",
    `A seat opened in ${where} at ${input.event.name}. It is being held for ${input.youthName}, who is next on the class waitlist.`,
    "",
    `Please accept the seat by ${formatExpiry(input.expiresAt, input.event.timezone)} (${input.event.timezone.replace(/_/g, " ")}). If it isn't accepted by then, the seat goes to the next youth in line.`,
    "",
    "Accept or decline it on your club's page:",
    link,
    "",
    "IMSDA Events",
  ].join("\n");
  const idempotencyKey = `honor-class-waitlist-offer:${input.entryId}:${input.offerCount}`;
  const suppressed = settings.deliveryMode === "DISABLED";
  const message = await tx.messageOutbox.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      eventId: input.event.id,
      registrationId: input.registration.id,
      templateKey: "HONOR_CLASS_WAITLIST_OFFER",
      recipientKind: "INTERNAL",
      recipientEmail: email,
      recipientName: name || null,
      senderNameSnapshot: settings.senderName,
      senderEmailSnapshot: settings.senderEmail,
      replyToEmailSnapshot: settings.replyToEmail,
      subjectSnapshot: `A seat is held in ${input.className} for ${input.youthName}`,
      bodyTextSnapshot: text,
      metadata: {
        trigger: "HONOR_CLASS_WAITLIST_OFFER",
        deliveryMode: settings.deliveryMode,
        realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
        confirmationCode: input.registration.confirmationCode,
        waitlistEntryId: input.entryId,
      },
      idempotencyKey,
      correlationId: randomUUID(),
      status: suppressed ? "SUPPRESSED" : "PENDING",
      lastError: suppressed ? "Delivery is disabled for this event." : null,
    },
    select: { id: true, status: true },
  });
  return message.status === "PENDING" ? message.id : null;
}

/** Delivery runs after the transaction commits and never rolls a committed change back; a failure leaves the message queued for the sweep. */
export async function deliverWaitlistOfferMessages(messageIds: readonly string[]) {
  if (messageIds.length === 0) return;
  try {
    await processQueuedMessageIdsAfterCommit([...messageIds]);
  } catch (error) {
    logError("A class waitlist offer email could not be delivered right now; it stays queued.", error);
  }
}

// ---------------------------------------------------------------------------
// Offering seats to the next in line
// ---------------------------------------------------------------------------

export type PromotionResult = { messageIds: string[]; offered: number; lapsed: number };

const waitingEntrySelect = {
  id: true, organizationId: true, registrationAttendeeId: true, registrationId: true, offerCount: true,
  levelConfirmedByDirector: true, prerequisitesConfirmedByDirector: true, requirementOverrideReason: true,
  registrationAttendee: { select: { profileSnapshot: true } },
  registration: {
    select: {
      id: true, status: true, locationId: true, confirmationCode: true, contactSnapshot: true,
      location: { select: locationDates },
      accountHolderPerson: { select: { firstName: true, lastName: true, normalizedEmail: true } },
    },
  },
} satisfies Prisma.HonorClassWaitlistEntrySelect;

/**
 * Lapses what has run out and offers each class's free seats to the next in line.
 * Must run inside a transaction; it takes the class locks itself (a no-op when the
 * caller already holds them). Free seats are capacity less seats taken and less live
 * offers, so it can never offer a seat that is taken or already offered.
 */
export async function promoteClassWaitlists(tx: Tx, eventId: string, offeringIds: readonly string[], now: Date, silentEntryIds: ReadonlySet<string> = new Set()): Promise<PromotionResult> {
  const ids = [...new Set(offeringIds)].sort();
  const result: PromotionResult = { messageIds: [], offered: 0, lapsed: 0 };
  if (ids.length === 0) return result;
  await lockOfferings(tx, ids);
  const event = await tx.event.findUnique({ where: { id: eventId }, select: lifecycleEvent });
  if (!event) return result;
  const offeringsById = new Map((await loadOfferings(tx, eventId)).map((offering) => [offering.id, offering]));
  const prerequisiteHonorIds = await eventPrerequisiteHonorIds(tx, eventId);
  for (const offeringId of ids) {
    const offering = offeringsById.get(offeringId);
    if (!offering) continue;
    const one = await promoteOne(tx, event, offering, offeringsById, prerequisiteHonorIds, now, silentEntryIds);
    result.messageIds.push(...one.messageIds);
    result.offered += one.offered;
    result.lapsed += one.lapsed;
  }
  return result;
}

async function promoteOne(
  tx: Tx,
  event: LifecycleEvent,
  offering: Awaited<ReturnType<typeof loadOfferings>>[number],
  offeringsById: ReadonlyMap<string, Awaited<ReturnType<typeof loadOfferings>>[number]>,
  prerequisiteHonorIds: readonly string[],
  now: Date,
  /** Entries the caller is about to settle itself (a direct pick of the class they wait on): they keep their turn but are not offered, so no email goes out for a seat they take at once. */
  silentEntryIds: ReadonlySet<string>,
) {
  const out: PromotionResult = { messageIds: [], offered: 0, lapsed: 0 };
  const eventId = event.id;

  // 1. Offers that ran out, that the class-change deadline cut off, or whose registration was cancelled give their seat back.
  const holding = await tx.honorClassWaitlistEntry.findMany({
    where: { offeringId: offering.id, status: "OFFERED" },
    select: { id: true, offerExpiresAt: true, registrationAttendeeId: true, registration: { select: { status: true, location: { select: locationDates } } } },
  });
  for (const entry of holding) {
    const cancelled = !activeStatuses.includes(entry.registration.status as ActiveStatus);
    const ranOut = entry.offerExpiresAt === null || entry.offerExpiresAt.getTime() <= now.getTime();
    const closed = !classChangesOpen(event, entry.registration.location, now);
    const inactive = !offering.isActive;
    if (!cancelled && !ranOut && !closed && !inactive) continue;
    const resolution = cancelled ? "Registration cancelled" : inactive ? "Class no longer offered" : ranOut ? "Offer expired" : "Class changes closed";
    const changed = await tx.honorClassWaitlistEntry.updateMany({
      where: { id: entry.id, status: "OFFERED" },
      data: { status: cancelled ? "REMOVED" : "EXPIRED", resolvedAt: now, resolution },
    });
    if (changed.count === 1) {
      out.lapsed += 1;
      await writeAuditLog({
        eventId, action: cancelled ? "HONOR_CLASS_WAITLIST_REMOVED" : "HONOR_CLASS_WAITLIST_OFFER_EXPIRED", entityType: "HonorClassWaitlistEntry", entityId: entry.id,
        summary: cancelled ? "A class waitlist place was removed because the registration was cancelled." : "A class waitlist offer lapsed, so the seat passes to the next youth.",
        metadata: { offeringId: offering.id, registrationAttendeeId: entry.registrationAttendeeId, resolution, system: true },
      }, tx);
    }
  }
  // Places of cancelled registrations are cleaned off the list.
  await tx.honorClassWaitlistEntry.updateMany({
    where: { offeringId: offering.id, status: "WAITING", registration: { status: { notIn: activeStatuses } } },
    data: { status: "REMOVED", resolvedAt: now, resolution: "Registration cancelled" },
  });

  // Places that can never be offered again are closed and audited rather than left waiting forever: the class was
  // deactivated, or class changes have closed for good for the youth's site (the event or the site ended or closed).
  const waitingNow = await tx.honorClassWaitlistEntry.findMany({
    where: { offeringId: offering.id, status: "WAITING" },
    select: { id: true, registrationAttendeeId: true, registration: { select: { location: { select: locationDates } } } },
  });
  for (const entry of waitingNow) {
    const reason = !offering.isActive ? "Class no longer offered" : classChangesEnded(event, entry.registration.location, now) ? "Class changes closed" : null;
    if (!reason) continue;
    const closedNow = await tx.honorClassWaitlistEntry.updateMany({ where: { id: entry.id, status: "WAITING" }, data: { status: "REMOVED", resolvedAt: now, resolution: reason } });
    if (closedNow.count === 1) {
      out.lapsed += 1;
      await writeAuditLog({
        eventId, action: "HONOR_CLASS_WAITLIST_REMOVED", entityType: "HonorClassWaitlistEntry", entityId: entry.id,
        summary: "A class waitlist place was closed because it can no longer be offered.",
        metadata: { offeringId: offering.id, registrationAttendeeId: entry.registrationAttendeeId, resolution: reason, system: true },
      }, tx);
    }
  }
  if (!offering.isActive) return out;

  // 2. Free seats: capacity less seats taken and less seats held by live offers.
  const [taken, live, clubSeatRows, clubOfferRows] = await Promise.all([
    tx.honorEnrollment.count({ where: { offeringId: offering.id, ...seatHoldingEnrollment } }),
    tx.honorClassWaitlistEntry.count({ where: { offeringId: offering.id, ...liveWaitlistOffer(now) } }),
    tx.honorEnrollment.groupBy({ by: ["organizationId"], where: { offeringId: offering.id, ...seatHoldingEnrollment }, _count: { _all: true } }),
    tx.honorClassWaitlistEntry.groupBy({ by: ["organizationId"], where: { offeringId: offering.id, ...liveWaitlistOffer(now) }, _count: { _all: true } }),
  ]);
  const free = seatsFree(offering.capacity, taken, live);
  if (free === 0) return out;

  // 3. In join order, who can take a seat now. Anyone who can't is skipped and keeps their place.
  const waiting = await tx.honorClassWaitlistEntry.findMany({
    where: { offeringId: offering.id, status: "WAITING", registration: { status: { in: activeStatuses } } },
    orderBy: [{ joinOrder: "asc" }, { id: "asc" }],
    select: waitingEntrySelect,
  });
  if (waiting.length === 0) return out;
  const attendeeIds = waiting.map((entry) => entry.registrationAttendeeId);
  const memberIds = waiting.map((entry) => (entry.registrationAttendee.profileSnapshot as Snapshot).clubRosterMemberId).filter((id): id is string => Boolean(id));
  const [members, requirements, heldRows] = await Promise.all([
    memberIds.length > 0 ? tx.clubRosterMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, attendeeType: true } }) : Promise.resolve([]),
    loadMemberRequirements(tx, memberIds, prerequisiteHonorIds),
    tx.honorEnrollment.findMany({ where: { registrationAttendeeId: { in: attendeeIds } }, select: { registrationAttendeeId: true, offeringId: true } }),
  ]);
  const typeByMember = new Map(members.map((member) => [member.id, member.attendeeType]));
  const heldByAttendee = new Map<string, string[]>();
  for (const row of heldRows) heldByAttendee.set(row.registrationAttendeeId, [...(heldByAttendee.get(row.registrationAttendeeId) ?? []), row.offeringId]);

  const candidates: OfferCandidate[] = waiting.map((entry) => {
    const snapshot = entry.registrationAttendee.profileSnapshot as Snapshot;
    const base = { id: entry.id, organizationId: entry.organizationId };
    if (!sessionVisibleAtLocation(offering.siteId, entry.registration.locationId)) return { ...base, skipReason: "The class isn't offered at their site." };
    if (!classChangesOpen(event, entry.registration.location, now)) return { ...base, skipReason: waitingNote("DEADLINE_PASSED") };
    const attendeeType = snapshot.clubRosterMemberId ? typeByMember.get(snapshot.clubRosterMemberId) ?? null : snapshot.temporaryAttendeeType ?? null;
    if (!consumesClassSeat(attendeeType)) return { ...base, skipReason: "They no longer use a class seat." };
    const heldIds = heldByAttendee.get(entry.registrationAttendeeId) ?? [];
    const heldOfferings = heldIds.map((id) => offeringsById.get(id)).filter((held): held is NonNullable<typeof held> => Boolean(held));
    if (holdsConflictingClass(offering, heldOfferings)) return { ...base, skipReason: waitingNote("HOLDS_CLASS_IN_SESSION") };
    const known = snapshot.clubRosterMemberId ? requirements.get(snapshot.clubRosterMemberId) : undefined;
    const person = {
      ageOnEventDate: typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null,
      consumesSeat: true,
      classLevel: known?.classLevel ?? null,
      completedHonorIds: known?.completedHonorIds ?? [],
    };
    const waivers = waiversOf(entry, offering.id);
    const problem = selectionProblem(person, [...heldIds, offering.id], offeringsById as ReadonlyMap<string, SelectableOffering>, new Set(heldIds), waivers);
    if (problem) return { ...base, skipReason: waitingNote("NOT_ELIGIBLE") };
    return { ...base, skipReason: null };
  });

  const plan = planOffers({
    freeSeats: free,
    candidates,
    perClubLimit: offering.perClubLimit,
    clubSeats: new Map(clubSeatRows.flatMap((row) => (row.organizationId ? [[row.organizationId, row._count._all] as const] : []))),
    clubLiveOffers: new Map(clubOfferRows.flatMap((row) => (row.organizationId ? [[row.organizationId, row._count._all] as const] : []))),
  });

  // 4. Offer the seats, in order, and tell each director once.
  const expiresAt = offerExpiresAt(now, event.honorWaitlistOfferHours);
  for (const entryId of plan.offered) {
    if (silentEntryIds.has(entryId)) continue;
    const entry = waiting.find((candidate) => candidate.id === entryId)!;
    const updated = await tx.honorClassWaitlistEntry.updateMany({
      where: { id: entryId, status: "WAITING" },
      data: { status: "OFFERED", offeredAt: now, offerExpiresAt: expiresAt, offerCount: { increment: 1 }, resolvedAt: null, resolution: null },
    });
    if (updated.count !== 1) continue;
    out.offered += 1;
    const snapshot = entry.registrationAttendee.profileSnapshot as Snapshot;
    const messageId = await queueOfferEmail(tx, {
      event,
      entryId,
      offerCount: entry.offerCount + 1,
      registration: entry.registration,
      organizationId: entry.organizationId,
      className: offering.honorName,
      sessionName: offering.sessionName,
      youthName: nameOf(snapshot),
      expiresAt,
    });
    if (messageId) out.messageIds.push(messageId);
    await writeAuditLog({
      eventId, action: "HONOR_CLASS_WAITLIST_OFFERED", entityType: "HonorClassWaitlistEntry", entityId: entryId,
      summary: "A seat in a full class was offered to the next youth on its waitlist.",
      metadata: {
        offeringId: offering.id, registrationId: entry.registrationId, registrationAttendeeId: entry.registrationAttendeeId,
        offerCount: entry.offerCount + 1, expiresAt: expiresAt.toISOString(), emailQueued: Boolean(messageId), system: true,
      },
    }, tx);
  }
  return out;
}

function waiversOf(
  entry: { levelConfirmedByDirector: boolean; prerequisitesConfirmedByDirector: boolean; requirementOverrideReason: string | null },
  offeringId: string,
): RequirementWaivers {
  return {
    confirmed: entry.levelConfirmedByDirector || entry.prerequisitesConfirmedByDirector ? new Set([offeringId]) : new Set<string>(),
    overrides: entry.requirementOverrideReason ? new Map([[offeringId, entry.requirementOverrideReason]]) : new Map<string, string>(),
  };
}

/**
 * Run inside a class-pick save, after its seats are saved and before it commits (#831): an offer this
 * registration's youth can no longer take (they now hold a class in that session) goes back to waiting
 * (keeping its place) and passes on, and the seats the save freed, or that a changed pick makes takeable,
 * go to the next youth in line. The caller already locked the freed classes and this registration's.
 */
export async function settleWaitlistAfterSave(tx: Tx, input: { eventId: string; registrationId: string; freedOfferingIds: readonly string[]; now: Date }) {
  const open = await tx.honorClassWaitlistEntry.findMany({
    where: { registrationId: input.registrationId, status: { in: ["WAITING", "OFFERED"] } },
    select: { id: true, status: true, offeringId: true, registrationAttendeeId: true },
  });
  const touched = new Set<string>(input.freedOfferingIds);
  if (open.length > 0) {
    const [offerings, heldRows] = await Promise.all([
      loadOfferings(tx, input.eventId),
      tx.honorEnrollment.findMany({ where: { registrationId: input.registrationId }, select: { registrationAttendeeId: true, offeringId: true } }),
    ]);
    const byId = new Map(offerings.map((offering) => [offering.id, offering]));
    for (const entry of open) {
      touched.add(entry.offeringId);
      if (entry.status !== "OFFERED") continue;
      const offering = byId.get(entry.offeringId);
      const held = heldRows.filter((row) => row.registrationAttendeeId === entry.registrationAttendeeId).map((row) => byId.get(row.offeringId)).filter((x): x is NonNullable<typeof x> => Boolean(x));
      if (!offering || !holdsConflictingClass(offering, held)) continue;
      const released = await tx.honorClassWaitlistEntry.updateMany({
        where: { id: entry.id, status: "OFFERED" },
        data: { status: "WAITING", offeredAt: null, offerExpiresAt: null, resolution: "Offer released: already holds a class in that session" },
      });
      if (released.count === 1) {
        await writeAuditLog({
          eventId: input.eventId, action: "HONOR_CLASS_WAITLIST_OFFER_RELEASED", entityType: "HonorClassWaitlistEntry", entityId: entry.id,
          summary: "A class waitlist offer was released because the youth now holds another class in that session; they keep their place.",
          metadata: { offeringId: entry.offeringId, registrationAttendeeId: entry.registrationAttendeeId },
        }, tx);
      }
    }
  }
  return promoteClassWaitlists(tx, input.eventId, [...touched], input.now);
}

/**
 * Passes seats on after a registration is cancelled (#831): its seats came free, and its own places on
 * waitlists end. Best effort and idempotent: the sweep does the same, so a failure here only delays the offer.
 */
export async function promoteAfterRegistrationCancelled(registrationId: string, now = new Date()) {
  const prisma = getPrisma();
  try {
    const registration = await prisma.registration.findUnique({ where: { id: registrationId }, select: { eventId: true } });
    if (!registration) return;
    const [seats, places] = await Promise.all([
      prisma.honorEnrollment.findMany({ where: { registrationId, consumesSeat: true }, select: { offeringId: true } }),
      prisma.honorClassWaitlistEntry.findMany({ where: { registrationId, status: { in: ["WAITING", "OFFERED"] } }, select: { offeringId: true } }),
    ]);
    const ids = [...new Set([...seats, ...places].map((row) => row.offeringId))];
    if (ids.length === 0) return;
    const result = await runSerializable((tx) => promoteClassWaitlists(tx, registration.eventId, ids, now));
    await deliverWaitlistOfferMessages(result.messageIds);
  } catch (error) {
    logError("Passing class seats on after a cancellation failed; the next sweep will.", error);
  }
}

async function runSerializable<T>(work: (tx: Tx) => Promise<T>) {
  const prisma = getPrisma();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");
      if (!retryable) throw error;
      if (attempt === 3) throw new ClassSelectionError("SELECTION_CONFLICT", "Several people were choosing classes at once. Please try again.");
    }
  }
}

/**
 * Closes every open place (waiting or holding an offer) on a class, audited with the reason. Staff call it in the
 * transaction that deactivates the class, so no one waits, or holds a seat offer, on a class that is gone (#831).
 */
export async function closeClassWaitlist(tx: Tx, input: { eventId: string; offeringId: string; reason: string; actorUserId?: string; now?: Date }) {
  const now = input.now ?? new Date();
  const open = await tx.honorClassWaitlistEntry.findMany({
    where: { offeringId: input.offeringId, status: { in: ["WAITING", "OFFERED"] } },
    select: { id: true, status: true, registrationAttendeeId: true },
  });
  for (const entry of open) {
    const changed = await tx.honorClassWaitlistEntry.updateMany({
      where: { id: entry.id, status: { in: ["WAITING", "OFFERED"] } },
      data: { status: entry.status === "OFFERED" ? "EXPIRED" : "REMOVED", resolvedAt: now, resolution: input.reason },
    });
    if (changed.count !== 1) continue;
    await writeAuditLog({
      eventId: input.eventId, ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}), action: "HONOR_CLASS_WAITLIST_REMOVED",
      entityType: "HonorClassWaitlistEntry", entityId: entry.id,
      summary: "A class waitlist place was closed because it can no longer be offered.",
      metadata: { offeringId: input.offeringId, registrationAttendeeId: entry.registrationAttendeeId, resolution: input.reason },
    }, tx);
  }
  return open.length;
}

export type WaitlistSweepResult = { classes: number; offered: number; lapsed: number; failed: number; budgetExhausted: boolean };

/**
 * The time-based trigger (#831). The outbox sweep calls this every few minutes. It works class by class, each in its
 * own serializable transaction: offers that ran out lapse first (earliest expiry first, so the oldest seat is passed on
 * first), then every other class with a line is advanced. Places that can never be offered again (the class was deactivated,
 * or the event or site's class changes closed for good) are closed and audited as they are reached, so finished classes
 * leave the sweep's work. It pages through everything rather than stopping at a cap; `maxClasses` only bounds one run.
 * One class failing (a busy lock, say) is counted and left for the next sweep.
 */
export async function sweepClassWaitlists(now = new Date(), pageSize = 100, maxClasses = 5000, budgetMs = 20_000): Promise<WaitlistSweepResult> {
  const prisma = getPrisma();
  const result: WaitlistSweepResult = { classes: 0, offered: 0, lapsed: 0, failed: 0, budgetExhausted: false };
  const startedAt = Date.now();
  // One sweep request is bounded: past the budget no new class is started, and the next sweep carries on.
  const outOfTime = () => {
    if (Date.now() - startedAt <= budgetMs) return false;
    result.budgetExhausted = true;
    return true;
  };
  const done = new Set<string>();
  const advance = async (row: { eventId: string; offeringId: string }) => {
    if (done.has(row.offeringId)) return;
    done.add(row.offeringId);
    result.classes += 1;
    try {
      const one = await runSerializable((tx) => promoteClassWaitlists(tx, row.eventId, [row.offeringId], now));
      result.offered += one.offered;
      result.lapsed += one.lapsed;
      await deliverWaitlistOfferMessages(one.messageIds);
    } catch (error) {
      result.failed += 1;
      logError("A class waitlist could not be advanced in this sweep; the next one will try again.", error, { offeringId: row.offeringId });
    }
  };
  // Phase A: classes with an offer that has run out, earliest expiry first.
  while (result.classes < maxClasses && !outOfTime()) {
    const rows = await prisma.honorClassWaitlistEntry.findMany({
      where: { status: "OFFERED", offerExpiresAt: { lte: now }, offeringId: { notIn: [...done] } },
      orderBy: [{ offerExpiresAt: "asc" }, { id: "asc" }],
      select: { eventId: true, offeringId: true },
      take: pageSize,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (outOfTime()) break;
      await advance(row);
    }
  }
  // Phase B: every other class that still has a line, by id.
  let after: string | undefined;
  while (result.classes < maxClasses && !outOfTime()) {
    const rows = await prisma.honorClassWaitlistEntry.findMany({
      where: { status: { in: ["WAITING", "OFFERED"] }, ...(after ? { offeringId: { gt: after } } : {}) },
      orderBy: [{ offeringId: "asc" }],
      select: { eventId: true, offeringId: true },
      distinct: ["offeringId"],
      take: pageSize,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (outOfTime()) break;
      await advance(row);
    }
    after = rows[rows.length - 1]!.offeringId;
  }
  return result;
}

// ---------------------------------------------------------------------------
// The director's actions
// ---------------------------------------------------------------------------

export { ClassSelectionError };

export type JoinWaitlistInput = {
  attendeeId: string;
  offeringId: string;
  /** The director confirms the youth meets a missing class level or honor record (#832). */
  confirmed?: boolean;
  /** Staff acting as the director only: why a youth who doesn't meet a rule is placed anyway (#832). */
  overrideReason?: string;
};

/** Puts a youth on a full class's waitlist. Takes no seat and doesn't count toward the club's limit. */
export async function joinClassWaitlist(organizationId: string, eventId: string, actor: ClassSelectionActor, input: JoinWaitlistInput, now = new Date()) {
  const overrideReason = input.overrideReason?.trim() || null;
  if (overrideReason && !("userId" in actor)) {
    throw new ClassSelectionError("SELECTION_INVALID", "Only staff can place someone who doesn't meet a class requirement.");
  }
  const owner = { kind: "club" as const, organizationId };
  let messageIds: string[] = [];
  await runSerializable(async (tx) => {
    messageIds = [];
    const registration = await loadRegistration(tx, owner, eventId);
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: lifecycleEvent });
    const location = registration.location ? await tx.eventLocation.findUnique({ where: { id: registration.location.id }, select: locationDates }) : null;
    if (!classChangesOpen(event, location, now)) throw new ClassSelectionError("DEADLINE_PASSED", closedMessage(event, location, now));
    if (registration.locationRequired) throw new ClassSelectionError("LOCATION_REQUIRED", chooseLocationFirstMessage);
    const attendee = registration.attendees.find((candidate) => candidate.id === input.attendeeId);
    if (!attendee) throw new ClassSelectionError("ATTENDEE_NOT_FOUND", "That person isn't on your club's registration.");
    const who = `${attendee.firstName} ${attendee.lastName}`.trim();
    if (!attendee.consumesSeat) throw new ClassSelectionError("SELECTION_INVALID", `${who}: staff, adults and underage children don't use a class seat, so they don't use a waitlist spot either.`);
    const offerings = await loadOfferings(tx, eventId);
    const offering = offerings.find((candidate) => candidate.id === input.offeringId);
    if (!offering || !sessionVisibleAtLocation(offering.siteId, registration.location?.id ?? null)) {
      throw new ClassSelectionError("SELECTION_INVALID", "That class isn't offered at your location.");
    }
    if (!offering.isActive) throw new ClassSelectionError("SELECTION_INVALID", `${offering.honorName} is no longer offered.`);
    await lockOfferings(tx, [offering.id]);

    const held = await tx.honorEnrollment.findFirst({ where: { registrationAttendeeId: attendee.id, offeringId: offering.id }, select: { id: true } });
    if (held) throw new ClassSelectionError("SELECTION_INVALID", `${who} already has a seat in ${offering.honorName}.`);
    // Eligible for this class, on its own: age, class level and prerequisite honors (#832).
    const waivers: RequirementWaivers = {
      confirmed: input.confirmed ? new Set([offering.id]) : new Set<string>(),
      overrides: overrideReason ? new Map([[offering.id, overrideReason]]) : new Map<string, string>(),
    };
    const byId = new Map<string, SelectableOffering & (typeof offerings)[number]>(offerings.map((candidate) => [candidate.id, candidate]));
    const problem = selectionProblem(attendee, [offering.id], byId, new Set(), waivers);
    if (problem) throw new ClassSelectionError("SELECTION_INVALID", `${who}: ${problem}`);
    const resolution = requirementResolution(attendee, offering, waivers);

    // Offers that ran out give their seat to the line first, so "still has a seat" below is a seat nobody in line can take.
    messageIds = (await promoteClassWaitlists(tx, eventId, [offering.id], now)).messageIds;
    const [taken, live] = await Promise.all([
      tx.honorEnrollment.count({ where: { offeringId: offering.id, ...seatHoldingEnrollment } }),
      tx.honorClassWaitlistEntry.count({ where: { offeringId: offering.id, ...liveWaitlistOffer(now) } }),
    ]);
    if (seatsFree(offering.capacity, taken, live) > 0) {
      throw new ClassSelectionError("WAITLIST_NOT_NEEDED", `${offering.honorName} still has a seat. Choose it directly.`);
    }
    const existing = await tx.honorClassWaitlistEntry.findFirst({ where: { registrationAttendeeId: attendee.id, offeringId: offering.id, status: { in: ["WAITING", "OFFERED"] } }, select: { id: true } });
    if (existing) throw new ClassSelectionError("ALREADY_WAITING", `${who} is already on the waitlist for ${offering.honorName}.`);

    const entry = await tx.honorClassWaitlistEntry.create({
      data: {
        eventId, offeringId: offering.id, registrationId: registration.registrationId, registrationAttendeeId: attendee.id, organizationId,
        levelConfirmedByDirector: resolution.levelConfirmed,
        prerequisitesConfirmedByDirector: resolution.prerequisitesConfirmed,
        requirementOverrideReason: resolution.overrideReason,
        requirementOverriddenByUserId: resolution.overrideReason && "userId" in actor ? actor.userId : null,
      },
      select: { id: true, joinOrder: true },
    });
    await writeAuditLog({
      eventId, ...actorFields(actor), action: "HONOR_CLASS_WAITLIST_JOINED", entityType: "HonorClassWaitlistEntry", entityId: entry.id,
      summary: "A club director put a youth on a full class's waitlist.",
      metadata: {
        organizationId, offeringId: offering.id, registrationAttendeeId: attendee.id, joinOrder: entry.joinOrder, ...actorMetadata(actor),
        ...(resolution.levelConfirmed || resolution.prerequisitesConfirmed ? { requirementsConfirmed: { level: resolution.levelConfirmed, prerequisites: resolution.prerequisitesConfirmed } } : {}),
        ...(resolution.overrideReason ? { overridden: true, unmet: requirementGaps(attendee, offering).map((gap) => gap.kind) } : {}),
      },
    }, tx);
  });
  await deliverWaitlistOfferMessages(messageIds);
  return getClassSelectionWorkspace(organizationId, eventId, now);
}

/** The director accepts the seat offered to a youth. Re-checks that they still qualify, then takes the seat held for them. */
export async function acceptClassWaitlistOffer(organizationId: string, eventId: string, actor: ClassSelectionActor, entryId: string, now = new Date()) {
  const owner = { kind: "club" as const, organizationId };
  let expired = false;
  let refusal: ClassSelectionError | null = null;
  let offeringOfEntry = "";
  let messageIds: string[] = [];
  await runSerializable(async (tx) => {
    expired = false;
    refusal = null;
    messageIds = [];
    const found = await tx.honorClassWaitlistEntry.findFirst({ where: { id: entryId, eventId, organizationId }, select: { id: true, offeringId: true } });
    if (!found) throw new ClassSelectionError("OFFER_NOT_FOUND", "That waitlist place wasn't found.");
    offeringOfEntry = found.offeringId;
    await lockOfferings(tx, [found.offeringId]);
    const entry = await tx.honorClassWaitlistEntry.findFirstOrThrow({
      where: { id: entryId },
      select: {
        id: true, status: true, offerExpiresAt: true, offeringId: true, registrationId: true, registrationAttendeeId: true, offerCount: true,
        levelConfirmedByDirector: true, prerequisitesConfirmedByDirector: true, requirementOverrideReason: true, requirementOverriddenByUserId: true,
      },
    });
    // Accepting twice returns the first outcome.
    if (entry.status === "ACCEPTED") return;
    if (entry.status !== "OFFERED") throw new ClassSelectionError("OFFER_NOT_FOUND", "There is no seat on offer for this place in line.");
    const registration = await loadRegistration(tx, owner, eventId);
    if (registration.registrationId !== entry.registrationId) throw new ClassSelectionError("OFFER_NOT_FOUND", "That waitlist place isn't on your club's registration.");
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: lifecycleEvent });
    const location = registration.location ? await tx.eventLocation.findUnique({ where: { id: registration.location.id }, select: locationDates }) : null;
    if (entry.offerExpiresAt === null || entry.offerExpiresAt.getTime() <= now.getTime()) {
      // The window ran out: record it and pass the seat on, then tell the director (outside, so this commits).
      expired = true;
      messageIds = (await promoteClassWaitlists(tx, eventId, [entry.offeringId], now)).messageIds;
      return;
    }
    if (!classChangesOpen(event, location, now)) {
      throw new ClassSelectionError("DEADLINE_PASSED", closedMessage(event, location, now));
    }
    const attendee = registration.attendees.find((candidate) => candidate.id === entry.registrationAttendeeId);
    if (!attendee) throw new ClassSelectionError("ATTENDEE_NOT_FOUND", "That person isn't on your club's registration.");
    const who = `${attendee.firstName} ${attendee.lastName}`.trim();
    const offerings = await loadOfferings(tx, eventId);
    const byId = new Map<string, SelectableOffering & (typeof offerings)[number]>(offerings.map((candidate) => [candidate.id, candidate]));
    const offering = byId.get(entry.offeringId);
    // A refusal below releases the offer (see after the transaction), so the seat isn't held for someone who can't take it.
    if (!offering || !sessionVisibleAtLocation(offering.siteId, registration.location?.id ?? null) || !offering.isActive) {
      refusal = new ClassSelectionError("SELECTION_INVALID", "That class isn't offered to your club any more.");
      return;
    }
    if (!attendee.consumesSeat) {
      refusal = new ClassSelectionError("SELECTION_INVALID", `${who} doesn't use a class seat.`);
      return;
    }
    const heldRows = await tx.honorEnrollment.findMany({ where: { registrationAttendeeId: attendee.id }, select: { offeringId: true } });
    const heldIds = heldRows.map((row) => row.offeringId);
    const heldOfferings = heldIds.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (holdsConflictingClass(offering, heldOfferings)) {
      refusal = new ClassSelectionError("SELECTION_INVALID", `${who} already has a class in this session, so the seat goes to the next youth in line. They keep their place.`);
      return;
    }
    // Eligibility is checked again now: the roster level or honor record may have changed since they joined (#832).
    const problem = selectionProblem(attendee, [...heldIds, offering.id], byId, new Set(heldIds), waiversOf(entry, offering.id));
    if (problem) {
      refusal = new ClassSelectionError("SELECTION_INVALID", `${who}: ${problem}`);
      return;
    }
    // Only seats count toward the per-club limit, never waitlist spots (#831); the seat this offer holds is not yet one.
    const [takenBefore, liveBefore, clubSeatsBefore] = await Promise.all([
      tx.honorEnrollment.count({ where: { offeringId: offering.id, ...seatHoldingEnrollment } }),
      tx.honorClassWaitlistEntry.count({ where: { offeringId: offering.id, ...liveWaitlistOffer(now) } }),
      tx.honorEnrollment.count({ where: { offeringId: offering.id, organizationId, ...seatHoldingEnrollment } }),
    ]);
    if (offering.perClubLimit !== null && clubSeatsBefore + 1 > offering.perClubLimit) {
      refusal = new ClassSelectionError("CLUB_LIMIT_REACHED", `${offering.honorName} allows ${offering.perClubLimit} youth per club, so the seat goes to the next youth in line. They keep their place.`);
      return;
    }
    // This offer is one of the live ones, so seats plus live offers already include it.
    if (takenBefore + liveBefore > offering.capacity) {
      refusal = new ClassSelectionError("CLASS_FULL", `${offering.honorName} is full.`);
      return;
    }

    // The seat is held for them: marking the offer accepted and taking the seat is one step.
    await tx.honorClassWaitlistEntry.update({ where: { id: entry.id }, data: { status: "ACCEPTED", resolvedAt: now, resolution: "Accepted by the director" } });
    await tx.honorEnrollment.create({
      data: {
        eventId, offeringId: offering.id, registrationId: registration.registrationId, registrationAttendeeId: attendee.id, organizationId,
        consumesSeat: true,
        levelConfirmedByDirector: entry.levelConfirmedByDirector,
        prerequisitesConfirmedByDirector: entry.prerequisitesConfirmedByDirector,
        requirementOverrideReason: entry.requirementOverrideReason,
        requirementOverriddenByUserId: entry.requirementOverriddenByUserId,
      },
    });
    await writeAuditLog({
      eventId, ...actorFields(actor), action: "HONOR_CLASS_WAITLIST_ACCEPTED", entityType: "HonorClassWaitlistEntry", entityId: entry.id,
      summary: "A club director accepted a seat offered from a class waitlist.",
      metadata: { organizationId, offeringId: offering.id, registrationAttendeeId: attendee.id, offerCount: entry.offerCount, ...actorMetadata(actor) },
    }, tx);
  });
  if (expired) {
    await deliverWaitlistOfferMessages(messageIds);
    throw new ClassSelectionError("OFFER_EXPIRED", "The time to accept this seat ran out, so it has gone to the next youth in line.");
  }
  if (refusal) {
    // The offer can't be taken: it goes back to waiting (keeping its place) and the seat passes to the next youth, in a
    // step of its own that commits even though the acceptance is refused (#831).
    const refused: ClassSelectionError = refusal;
    try {
      const released = await runSerializable(async (tx) => {
        await lockOfferings(tx, [offeringOfEntry]);
        const changed = await tx.honorClassWaitlistEntry.updateMany({
          where: { id: entryId, status: "OFFERED" },
          data: { status: "WAITING", offeredAt: null, offerExpiresAt: null, resolution: "Offer released: it could not be accepted" },
        });
        if (changed.count === 1) {
          await writeAuditLog({
            eventId, ...actorFields(actor), action: "HONOR_CLASS_WAITLIST_OFFER_RELEASED", entityType: "HonorClassWaitlistEntry", entityId: entryId,
            summary: "A class waitlist offer was released because it could not be accepted; the youth keeps their place.",
            metadata: { organizationId, offeringId: offeringOfEntry, code: refused.code, ...actorMetadata(actor) },
          }, tx);
        }
        return promoteClassWaitlists(tx, eventId, [offeringOfEntry], now);
      });
      await deliverWaitlistOfferMessages(released.messageIds);
    } catch (error) {
      // The director's answer is the refusal, whatever happens here; the sweep releases and passes on the offer when it lapses.
      logError("A refused class waitlist acceptance could not release its offer; the sweep will.", error, { entryId, offeringId: offeringOfEntry });
    }
    throw refused;
  }
  return getClassSelectionWorkspace(organizationId, eventId, now);
}

/** Takes a youth off a waitlist, or declines the seat offered to them (it passes to the next youth). */
export async function leaveClassWaitlist(organizationId: string, eventId: string, actor: ClassSelectionActor, entryId: string, now = new Date()) {
  let messageIds: string[] = [];
  await runSerializable(async (tx) => {
    messageIds = [];
    const found = await tx.honorClassWaitlistEntry.findFirst({ where: { id: entryId, eventId, organizationId }, select: { id: true, offeringId: true } });
    if (!found) throw new ClassSelectionError("OFFER_NOT_FOUND", "That waitlist place wasn't found.");
    await lockOfferings(tx, [found.offeringId]);
    const entry = await tx.honorClassWaitlistEntry.findFirstOrThrow({ where: { id: entryId }, select: { id: true, status: true, offeringId: true, registrationAttendeeId: true } });
    if (entry.status !== "WAITING" && entry.status !== "OFFERED") return;
    const declined = entry.status === "OFFERED";
    await tx.honorClassWaitlistEntry.update({
      where: { id: entry.id },
      data: { status: declined ? "DECLINED" : "REMOVED", resolvedAt: now, resolution: declined ? "Offer declined by the director" : "Removed by the director" },
    });
    await writeAuditLog({
      eventId, ...actorFields(actor), action: declined ? "HONOR_CLASS_WAITLIST_DECLINED" : "HONOR_CLASS_WAITLIST_REMOVED", entityType: "HonorClassWaitlistEntry", entityId: entry.id,
      summary: declined ? "A club director declined a seat offered from a class waitlist." : "A club director took a youth off a class waitlist.",
      metadata: { organizationId, offeringId: entry.offeringId, registrationAttendeeId: entry.registrationAttendeeId, ...actorMetadata(actor) },
    }, tx);
    // A declined seat goes straight to the next youth in line.
    if (declined) messageIds = (await promoteClassWaitlists(tx, eventId, [entry.offeringId], now)).messageIds;
  });
  await deliverWaitlistOfferMessages(messageIds);
  return getClassSelectionWorkspace(organizationId, eventId, now);
}

// ---------------------------------------------------------------------------
// What the director sees, and the event's acceptance window
// ---------------------------------------------------------------------------

export type ClubWaitlistView = {
  /** Whether class changes are still open for this registration's site, so joining, accepting and offers can happen. */
  open: boolean;
  /** The event's window to accept an offered seat. */
  offerHours: number;
  /** The event's time zone, so offer deadlines read the same everywhere. */
  timezone: string;
  entries: Array<{
    id: string;
    attendeeId: string;
    offeringId: string;
    status: "WAITING" | "OFFERED";
    /** Place in line among those waiting or holding an offer, from 1. */
    place: number;
    offerExpiresAt: string | null;
    /** An offer whose window ran out and is waiting to pass on. */
    expired: boolean;
    /** Why a waiting youth won't be offered the next seat, in words. */
    note: string | null;
  }>;
};

/** The club's own places on class waitlists; only the club's, with its place in line as a number. Never names or counts of other clubs. */
export async function getClubWaitlistView(
  client: Tx | ReturnType<typeof getPrisma>,
  input: {
    organizationId: string;
    registrationId: string;
    /** The registration's event and site, as the class workspace already loaded them. */
    event: Omit<LifecycleEvent, "id" | "name">;
    location: LocationDates;
    now: Date;
  },
): Promise<ClubWaitlistView> {
  const { organizationId, registrationId, now } = input;
  const event = { id: "", name: "", ...input.event };
  const open = classChangesOpen(event, input.location, now);
  const entries = await client.honorClassWaitlistEntry.findMany({
    where: { registrationId, organizationId, status: { in: ["WAITING", "OFFERED"] } },
    orderBy: [{ joinOrder: "asc" }],
    select: { id: true, registrationAttendeeId: true, offeringId: true, status: true, joinOrder: true, offerExpiresAt: true, offering: { select: { id: true, span: true, sessionId: true } } },
  });
  if (entries.length === 0) return { open, offerHours: event.honorWaitlistOfferHours ?? 24, timezone: event.timezone, entries: [] };
  const [line, held] = await Promise.all([
    client.honorClassWaitlistEntry.findMany({
      where: { offeringId: { in: [...new Set(entries.map((entry) => entry.offeringId))] }, status: { in: ["WAITING", "OFFERED"] } },
      select: { offeringId: true, joinOrder: true },
    }),
    client.honorEnrollment.findMany({
      where: { registrationAttendeeId: { in: entries.map((entry) => entry.registrationAttendeeId) } },
      select: { registrationAttendeeId: true, offering: { select: { id: true, span: true, sessionId: true } } },
    }),
  ]);
  return {
    open,
    offerHours: event.honorWaitlistOfferHours ?? 24,
    timezone: event.timezone,
    entries: entries.map((entry) => {
      const expired = entry.status === "OFFERED" && (entry.offerExpiresAt === null || entry.offerExpiresAt.getTime() <= now.getTime());
      const holdsConflict = holdsConflictingClass(entry.offering, held.filter((row) => row.registrationAttendeeId === entry.registrationAttendeeId).map((row) => row.offering));
      return {
        id: entry.id,
        attendeeId: entry.registrationAttendeeId,
        offeringId: entry.offeringId,
        status: entry.status as "WAITING" | "OFFERED",
        place: placeInLine(line.filter((row) => row.offeringId === entry.offeringId).map((row) => row.joinOrder), entry.joinOrder),
        offerExpiresAt: entry.offerExpiresAt?.toISOString() ?? null,
        expired,
        note: entry.status === "WAITING"
          ? (!open ? waitingNote("DEADLINE_PASSED") : holdsConflict ? waitingNote("HOLDS_CLASS_IN_SESSION") : null)
          : (holdsConflict && !expired ? "Already has a class in this session. Remove it to accept this seat, or decline the seat." : null),
      };
    }),
  };
}

/** Staff set how long a director has to accept an offered seat (hours, per event). */
export async function setHonorWaitlistOfferHours(eventId: string, hours: number, actorUserId: string) {
  if (!Number.isInteger(hours) || hours < waitlistOfferHoursMin || hours > waitlistOfferHoursMax) {
    throw new ClassSelectionError("SELECTION_INVALID", `The acceptance window must be a whole number of hours from ${waitlistOfferHoursMin} to ${waitlistOfferHoursMax}.`);
  }
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { honorWaitlistOfferHours: true } });
    if (!event) throw new HonorConfigurationError("EVENT_NOT_FOUND", "That event could not be found.");
    await tx.event.update({ where: { id: eventId }, data: { honorWaitlistOfferHours: hours } });
    await writeAuditLog({
      eventId, actorUserId, action: "HONOR_CLASS_WAITLIST_WINDOW_UPDATED", entityType: "Event", entityId: eventId,
      summary: "Staff changed how long a director has to accept a seat offered from a class waitlist.",
      metadata: { from: event.honorWaitlistOfferHours, to: hours },
    }, tx);
    return { offerHours: hours };
  });
}

export async function getHonorWaitlistOfferHours(eventId: string) {
  const event = await getPrisma().event.findUnique({ where: { id: eventId }, select: { honorWaitlistOfferHours: true } });
  return event?.honorWaitlistOfferHours ?? 24;
}
