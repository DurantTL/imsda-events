import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { CONFERENCE_TIME_ZONE } from "@/modules/calendar/domain";
import {
  auditActorFields,
  ClubOrderError,
  type ClubOrderActor,
  type Db,
  lockClubOrders,
  removeDepartedMemberNeeds,
} from "@/modules/club-orders/repository";
import { type ClubClassLevel, clubClassLevelLabels, clubYearFor } from "@/modules/club-rosters/domain";
import { clubSupplySectionLabels } from "@/modules/club-supplies/domain";
import {
  AWARD_SECTIONS,
  buildClassHistory,
  type ClassHistoryEntry,
  calendarDate,
  classInsigniaSourceId,
  classLabel,
  eventPatchSourceId,
  evaluateMasterAward,
  type InsigniaItem,
  masterAwardSourceId,
  matchInsigniaSet,
  originOf,
  progressLabel,
  type AwardOrigin,
} from "@/modules/earned-awards/domain";

/**
 * Earned awards as an order source (#532), the third counterpart of
 * `modules/honors/order-source.ts` and `modules/uniforms/order-source.ts`. A
 * need is a `ClubOrderNeed` with source type AWARD for one member and one
 * catalog item; from there everything is the generic order layer
 * (`modules/club-orders`): the same order batches, stock math, locks, exports
 * and audit. Status mapping: needed -> ordered -> received -> awarded.
 *
 * Four kinds of earned item, all created only here and always under the
 * club's own order lock:
 *   - class insignia: recording a class completion never orders anything; it
 *     makes that class's insignia set a *suggestion*, and only a director's
 *     confirmation creates the needs;
 *   - event patches: staff link a catalog item to a club event; attendees are
 *     suggested it, and only a confirmation creates the needs;
 *   - Master Awards: computed from stored rules and #486 honor records, added
 *     for members who reached them by a confirmation;
 *   - anything else (Good Conduct, TLT...): picked by hand from the catalog.
 *
 * Reads here never write; only an editor's workspace load drops departed
 * members' NEEDED needs, like uniforms.
 */

/** A hand-picked need's key is generated: a member can legitimately earn the same item again. */
export const manualAwardSourceId = () => `award:${randomUUID()}`;

const OPEN_STATUSES = ["NEEDED", "ORDERED", "RECEIVED"] as const;

const byName = (a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }) =>
  a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

export type AwardMember = { personId: string; firstName: string; lastName: string; classLabel: string };

/** The date of an event in the conference's time zone, as the calendar date its patches were earned. */
function eventDate(startsAt: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFERENCE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(startsAt);
}

/** Every person must be an active member of this club's roster this club year, or nothing is recorded. */
async function requireActiveMembers(tx: Db, organizationId: string, personIds: readonly string[], now: Date) {
  const members = await tx.clubRosterMember.findMany({
    where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { in: [...personIds] } },
    select: { personId: true },
  });
  const onRoster = new Set(members.map((member) => member.personId));
  if (personIds.some((personId) => !onRoster.has(personId))) {
    throw new ClubOrderError("MEMBER_NOT_ON_ROSTER", "Everyone must be an active member of this club's roster this year.");
  }
}

async function activeMemberIds(db: Db, organizationId: string, now: Date) {
  const rows = await db.clubRosterMember.findMany({
    where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { not: null } },
    select: { personId: true },
  });
  return [...new Set(rows.map((row) => row.personId!))];
}

async function nameMap(db: Db, personIds: Iterable<string>) {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return new Map<string, { firstName: string; lastName: string }>();
  const people = await db.person.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(people.map((person) => [person.id, { firstName: person.firstName, lastName: person.lastName }]));
}

// ---------------------------------------------------------------- hand-picked awards

/**
 * Records earned items by hand in bulk (Good Conduct, TLT, anything in the
 * award sections): every member x every item, under the club's lock. Members
 * must be active on this club's roster this club year; items must be active
 * catalog rows in an award section. A member who already has an open (needed,
 * ordered, or received) need for that item is skipped, so re-submitting never
 * doubles anything up. `alreadyHasIt` records the need directly as awarded:
 * nothing to order, and stock is never touched (and any existing NEEDED need
 * for it is settled the same way). Audited with counts and item ids only.
 */
export async function recordAwardNeeds(
  organizationId: string,
  input: { personIds: readonly string[]; itemIds: readonly string[]; alreadyHasIt: boolean },
  actor: ClubOrderActor,
  now = new Date(),
) {
  const personIds = [...new Set(input.personIds)];
  const itemIds = [...new Set(input.itemIds)];
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const items = await tx.clubSupplyItem.findMany({
      where: { id: { in: itemIds }, isActive: true, section: { in: [...AWARD_SECTIONS] } },
      select: { id: true, name: true },
    });
    if (items.length !== itemIds.length) {
      throw new ClubOrderError("ITEM_NOT_ORDERABLE", "One of those items isn't an active earned-award item in the supply catalog.");
    }
    await requireActiveMembers(tx, organizationId, personIds, now);
    const open = await tx.clubOrderNeed.findMany({
      where: {
        organizationId,
        sourceType: "AWARD",
        // "Already has it" also skips a member already recorded as awarded, so a double tap never records it twice.
        status: { in: input.alreadyHasIt ? [...OPEN_STATUSES, "AWARDED" as const] : [...OPEN_STATUSES] },
        personId: { in: personIds },
        itemId: { in: itemIds },
      },
      select: { id: true, personId: true, itemId: true, status: true },
    });
    let marked = 0;
    if (input.alreadyHasIt) {
      const neededIds = open.filter((need) => need.status === "NEEDED").map((need) => need.id);
      if (neededIds.length > 0) {
        marked = (await tx.clubOrderNeed.updateMany({
          where: { id: { in: neededIds }, organizationId, sourceType: "AWARD", status: "NEEDED" },
          data: { status: "AWARDED" },
        })).count;
      }
    }
    const alreadyOpen = new Set(open.map((need) => `${need.personId}\u0000${need.itemId}`));
    const data = items.flatMap((item) => personIds
      .filter((personId) => !alreadyOpen.has(`${personId}\u0000${item.id}`))
      .map((personId) => ({
        organizationId,
        sourceType: "AWARD" as const,
        sourceId: manualAwardSourceId(),
        personId,
        itemId: item.id,
        sourceLabel: item.name,
        sourceDate: calendarDate(now),
        status: input.alreadyHasIt ? ("AWARDED" as const) : ("NEEDED" as const),
      })));
    const skipped = personIds.length * itemIds.length - data.length - marked;
    if (data.length > 0) await tx.clubOrderNeed.createMany({ data });
    const who = auditActorFields(actor);
    if (marked > 0) {
      await writeAuditLog({
        ...who.actorFields,
        action: "CLUB_ORDER_MARKED_ALREADY_AWARDED",
        entityType: "ClubOrderNeed",
        summary: `Marked ${marked} club supply need${marked === 1 ? "" : "s"} as already handed out.`,
        metadata: { organizationId, needCount: marked, ...who.metadata },
      }, tx);
    }
    if (data.length > 0) {
      await writeAuditLog({
        ...who.actorFields,
        action: input.alreadyHasIt ? "CLUB_AWARD_NEEDS_RECORDED_AWARDED" : "CLUB_AWARD_NEEDS_RECORDED",
        entityType: "ClubOrderNeed",
        summary: input.alreadyHasIt
          ? `Recorded ${data.length} earned item${data.length === 1 ? "" : "s"} members already have.`
          : `Recorded ${data.length} earned item${data.length === 1 ? "" : "s"}.`,
        metadata: { organizationId, needCount: data.length, skippedCount: skipped, memberCount: personIds.length, itemIds, alreadyHasIt: input.alreadyHasIt, ...who.metadata },
      }, tx);
    }
    return { created: data.length, skipped, marked, alreadyHadIt: input.alreadyHasIt ? data.length + marked : 0 };
  });
}

/**
 * Removes earned items entered by mistake: only AWARD needs still NEEDED, so
 * anything on an order or awarded is never touched, and honor and uniform
 * needs are never reachable from here. Guarded delete under the club's lock;
 * one audit row with the count.
 */
export async function removeAwardNeeds(organizationId: string, needIds: readonly string[], actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const removed = await tx.clubOrderNeed.deleteMany({
      where: { id: { in: [...needIds] }, organizationId, sourceType: "AWARD", status: "NEEDED" },
    });
    if (removed.count === 0) return { removed: 0 };
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_AWARD_NEEDS_REMOVED",
      entityType: "ClubOrderNeed",
      summary: `Removed ${removed.count} not-yet-ordered earned item${removed.count === 1 ? "" : "s"}.`,
      metadata: { organizationId, needCount: removed.count, ...who.metadata },
    }, tx);
    return { removed: removed.count };
  });
}

// ---------------------------------------------------------------- class insignia

/**
 * Marks members as having completed a class (#532). This is the explicit
 * "completed a class" signal: the roster only stores a member's *current*
 * class, and nothing else in the app records that a class was finished, so
 * the director records it here. It orders nothing by itself; it only makes
 * that class's insignia set a suggestion (`listInsigniaSuggestions`). A member
 * already recorded for that class is skipped. Audited with counts only.
 */
export async function recordClassCompletions(
  organizationId: string,
  input: { personIds: readonly string[]; classLevel: ClubClassLevel; completedOn: string },
  actor: ClubOrderActor,
  now = new Date(),
) {
  const personIds = [...new Set(input.personIds)];
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    await requireActiveMembers(tx, organizationId, personIds, now);
    const created = await tx.memberClassCompletion.createMany({
      data: personIds.map((personId) => ({ organizationId, personId, classLevel: input.classLevel, completedOn: input.completedOn })),
      skipDuplicates: true,
    });
    const skipped = personIds.length - created.count;
    if (created.count > 0) {
      const who = auditActorFields(actor);
      await writeAuditLog({
        ...who.actorFields,
        action: "CLUB_CLASS_COMPLETIONS_RECORDED",
        entityType: "MemberClassCompletion",
        summary: `Marked ${created.count} member${created.count === 1 ? "" : "s"} as having completed the ${clubClassLevelLabels[input.classLevel]} class.`,
        metadata: { organizationId, classLevel: input.classLevel, memberCount: created.count, skippedCount: skipped, ...who.metadata },
      }, tx);
    }
    return { created: created.count, skipped };
  });
}

export type InsigniaSuggestion = {
  completionId: string;
  personId: string;
  firstName: string;
  lastName: string;
  classLevel: ClubClassLevel;
  classLabel: string;
  completedOn: string;
  /** Set items in the catalog and not yet added for this member. */
  items: InsigniaItem[];
  /** Set items the catalog doesn't have, flagged rather than dropped. */
  missing: string[];
};

async function insigniaCatalog(db: Db) {
  return db.clubSupplyItem.findMany({
    where: { section: "INVESTITURE", isActive: true },
    select: { id: true, section: true, name: true, catalogNumber: true },
  });
}

async function insigniaSuggestions(db: Db, organizationId: string, now: Date, only?: { completionIds: readonly string[] }) {
  const active = await activeMemberIds(db, organizationId, now);
  if (active.length === 0) return [];
  const completions = await db.memberClassCompletion.findMany({
    where: {
      organizationId,
      insigniaDismissedAt: null,
      personId: { in: active },
      ...(only ? { id: { in: [...only.completionIds] } } : {}),
    },
    orderBy: [{ completedOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, personId: true, classLevel: true, completedOn: true },
  });
  if (completions.length === 0) return [];
  const catalog = (await insigniaCatalog(db)).map((row) => ({ itemId: row.id, section: row.section, name: row.name, catalogNumber: row.catalogNumber }));
  const planned = completions.map((completion) => ({ completion, set: matchInsigniaSet(completion.classLevel, catalog) }));
  const sourceIds = planned.flatMap(({ completion, set }) => set.items.map((item) => classInsigniaSourceId(completion.personId, completion.classLevel, item.itemId)));
  const existing = sourceIds.length === 0 ? [] : await db.clubOrderNeed.findMany({
    where: { sourceType: "AWARD", sourceId: { in: sourceIds } },
    select: { sourceId: true },
  });
  const have = new Set(existing.map((row) => row.sourceId));
  const names = await nameMap(db, completions.map((completion) => completion.personId));
  return planned.flatMap(({ completion, set }): InsigniaSuggestion[] => {
    const items = set.items.filter((item) => !have.has(classInsigniaSourceId(completion.personId, completion.classLevel, item.itemId)));
    if (items.length === 0) return [];
    return [{
      completionId: completion.id,
      personId: completion.personId,
      firstName: names.get(completion.personId)?.firstName ?? "",
      lastName: names.get(completion.personId)?.lastName ?? "",
      classLevel: completion.classLevel,
      classLabel: classLabel(completion.classLevel),
      completedOn: completion.completedOn,
      items,
      missing: set.missing,
    }];
  }).sort((a, b) => byName(a, b) || a.classLabel.localeCompare(b.classLabel));
}

/** Insignia suggested for members marked as having completed a class and not yet added or skipped. Reads only. */
export async function listInsigniaSuggestions(organizationId: string, now = new Date()) {
  return insigniaSuggestions(getPrisma(), organizationId, now);
}

/**
 * The director's confirmation (#532): only what they confirm is added. Per
 * completion, the items must be in that class's set as the catalog has it
 * (`NOT_SUGGESTED` otherwise, and nothing is added at all). Needs are keyed on
 * member, class and item, so confirming twice, or from two screens at once,
 * adds each once. Audited with counts and item ids only.
 */
export async function confirmInsignia(
  organizationId: string,
  confirmations: ReadonlyArray<{ completionId: string; itemIds: readonly string[] }>,
  actor: ClubOrderActor,
  now = new Date(),
) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const completionIds = confirmations.map((entry) => entry.completionId);
    const completions = await tx.memberClassCompletion.findMany({
      where: { id: { in: completionIds }, organizationId, insigniaDismissedAt: null },
      select: { id: true, personId: true, classLevel: true, completedOn: true },
    });
    const byId = new Map(completions.map((completion) => [completion.id, completion]));
    if (completions.length !== new Set(completionIds).size) {
      throw new ClubOrderError("NOT_SUGGESTED", "One of those classes isn't waiting for its insignia to be confirmed.");
    }
    await requireActiveMembers(tx, organizationId, completions.map((completion) => completion.personId), now);
    const catalog = (await insigniaCatalog(tx)).map((row) => ({ itemId: row.id, section: row.section, name: row.name, catalogNumber: row.catalogNumber }));
    const data: Prisma.ClubOrderNeedCreateManyInput[] = [];
    const itemIds = new Set<string>();
    for (const entry of confirmations) {
      const completion = byId.get(entry.completionId)!;
      const set = new Map(matchInsigniaSet(completion.classLevel, catalog).items.map((item) => [item.itemId, item]));
      for (const itemId of new Set(entry.itemIds)) {
        if (!set.has(itemId)) throw new ClubOrderError("NOT_SUGGESTED", "One of those items isn't part of that class's insignia set.");
        itemIds.add(itemId);
        data.push({
          organizationId,
          sourceType: "AWARD",
          sourceId: classInsigniaSourceId(completion.personId, completion.classLevel, itemId),
          personId: completion.personId,
          itemId,
          sourceLabel: `${classLabel(completion.classLevel)} insignia`,
          sourceDate: completion.completedOn,
        });
      }
    }
    const created = await tx.clubOrderNeed.createMany({ data, skipDuplicates: true });
    const skipped = data.length - created.count;
    if (created.count > 0) {
      const who = auditActorFields(actor);
      await writeAuditLog({
        ...who.actorFields,
        action: "CLUB_CLASS_INSIGNIA_CONFIRMED",
        entityType: "ClubOrderNeed",
        summary: `Confirmed ${created.count} class insignia item${created.count === 1 ? "" : "s"}.`,
        metadata: { organizationId, needCount: created.count, skippedCount: skipped, completionCount: completions.length, itemIds: [...itemIds].sort(), ...who.metadata },
      }, tx);
    }
    return { created: created.count, skipped };
  });
}

/** "Not now" for a class's insignia (#532): it stops being suggested. Guarded; audited by count. */
export async function dismissInsignia(organizationId: string, completionIds: readonly string[], actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const dismissed = await tx.memberClassCompletion.updateMany({
      where: { id: { in: [...completionIds] }, organizationId, insigniaDismissedAt: null },
      data: { insigniaDismissedAt: new Date() },
    });
    if (dismissed.count === 0) return { dismissed: 0 };
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_CLASS_INSIGNIA_DISMISSED",
      entityType: "MemberClassCompletion",
      summary: `Chose not to order insignia for ${dismissed.count} completed class${dismissed.count === 1 ? "" : "es"}.`,
      metadata: { organizationId, completionCount: dismissed.count, ...who.metadata },
    }, tx);
    return { dismissed: dismissed.count };
  });
}

// ---------------------------------------------------------------- event patches

export type AttendanceBasis = "CHECK_IN" | "REGISTRATION";

type PatchCandidate = {
  eventId: string;
  eventName: string;
  eventDate: string;
  itemId: string;
  itemName: string;
  catalogNumber: string | null;
  basis: AttendanceBasis;
  /** Active members of this club who attended, before anything already added is set aside. */
  personIds: string[];
};

/**
 * Who attended each club event that has a linked patch or pin (#532). Only
 * this club's own registration counts (`ClubEventRegistration`, submitted or
 * confirmed). Attendance follows the repo's own rule (the Honors Weekend
 * write-back, #487): a person *checked in* to the event (an active check-in,
 * not undone). It is decided per club: if this club has any check-ins at the
 * event, its check-ins are used; if it has none (it never used check-in, even
 * though another club did), it falls back to its own registered members, but
 * only once the event is over, so a patch is never suggested for people who
 * might not show up. Either way only members active
 * on this club's roster this year are suggested.
 */
async function eventPatchCandidates(db: Db, organizationId: string, now: Date, only?: { eventId: string }): Promise<PatchCandidate[]> {
  const registrations = await db.clubEventRegistration.findMany({
    where: {
      organizationId,
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
      event: { startsAt: { lte: now }, awardItems: { some: {} }, ...(only ? { id: only.eventId } : {}) },
    },
    select: {
      eventId: true,
      event: {
        select: {
          name: true,
          startsAt: true,
          endsAt: true,
          awardItems: { where: { item: { isActive: true } }, select: { item: { select: { id: true, name: true, catalogNumber: true } } } },
        },
      },
      registration: {
        select: { attendees: { select: { profileSnapshot: true, checkIns: { where: { undoneAt: null }, select: { id: true }, take: 1 } } } },
      },
    },
  });
  if (registrations.length === 0) return [];
  const active = new Set(await activeMemberIds(db, organizationId, now));
  // An attendee is a member through the roster row the registration snapshot names (as the Honors Weekend
  // write-back does); a temporary attendee with no roster row has no record to give a patch to.
  const snapshotMemberId = (snapshot: unknown) => {
    const id = (snapshot as { clubRosterMemberId?: unknown } | null)?.clubRosterMemberId;
    return typeof id === "string" ? id : null;
  };
  const memberIds = [...new Set(registrations.flatMap((registration) => registration.registration.attendees.map((attendee) => snapshotMemberId(attendee.profileSnapshot)).filter((id): id is string => id !== null)))];
  const members = memberIds.length === 0 ? [] : await db.clubRosterMember.findMany({
    where: { id: { in: memberIds }, organizationId, personId: { not: null } },
    select: { id: true, personId: true },
  });
  const personByMember = new Map(members.map((member) => [member.id, member.personId!]));
  const candidates: PatchCandidate[] = [];
  for (const registration of registrations) {
    // Decided per club, not per event: another club checking in at the same event says nothing about whether
    // *this* club's check-in was used, so one club's check-ins must never switch this club's attendance off.
    const clubCheckedIn = registration.registration.attendees.some((attendee) => attendee.checkIns.length > 0);
    const basis: AttendanceBasis | null = clubCheckedIn
      ? "CHECK_IN"
      : registration.event.endsAt <= now ? "REGISTRATION" : null;
    if (!basis) continue;
    const attended = registration.registration.attendees
      .filter((attendee) => basis === "REGISTRATION" || attendee.checkIns.length > 0)
      .map((attendee) => personByMember.get(snapshotMemberId(attendee.profileSnapshot) ?? ""))
      .filter((personId): personId is string => personId !== undefined && active.has(personId));
    const personIds = [...new Set(attended)];
    for (const { item } of registration.event.awardItems) {
      candidates.push({
        eventId: registration.eventId,
        eventName: registration.event.name,
        eventDate: eventDate(registration.event.startsAt),
        itemId: item.id,
        itemName: item.name,
        catalogNumber: item.catalogNumber,
        basis,
        personIds,
      });
    }
  }
  return candidates;
}

export type PatchSuggestion = {
  eventId: string;
  eventName: string;
  eventDate: string;
  itemId: string;
  itemName: string;
  catalogNumber: string | null;
  /** Whether attendance came from check-in or, for an event with no check-ins, registration. */
  basis: AttendanceBasis;
  people: Array<{ personId: string; firstName: string; lastName: string }>;
};

/** Event patches suggested for attendees not yet given one. Reads only. */
export async function listPatchSuggestions(organizationId: string, now = new Date()): Promise<PatchSuggestion[]> {
  const db = getPrisma();
  const candidates = await eventPatchCandidates(db, organizationId, now);
  if (candidates.length === 0) return [];
  const sourceIds = candidates.flatMap((candidate) => candidate.personIds.map((personId) => eventPatchSourceId(candidate.eventId, personId, candidate.itemId)));
  const existing = sourceIds.length === 0 ? [] : await db.clubOrderNeed.findMany({
    where: { sourceType: "AWARD", sourceId: { in: sourceIds } },
    select: { sourceId: true },
  });
  const have = new Set(existing.map((row) => row.sourceId));
  const names = await nameMap(db, candidates.flatMap((candidate) => candidate.personIds));
  return candidates
    .map((candidate): PatchSuggestion => ({
      eventId: candidate.eventId,
      eventName: candidate.eventName,
      eventDate: candidate.eventDate,
      itemId: candidate.itemId,
      itemName: candidate.itemName,
      catalogNumber: candidate.catalogNumber,
      basis: candidate.basis,
      people: candidate.personIds
        .filter((personId) => !have.has(eventPatchSourceId(candidate.eventId, personId, candidate.itemId)))
        .map((personId) => ({ personId, firstName: names.get(personId)?.firstName ?? "", lastName: names.get(personId)?.lastName ?? "" }))
        .sort(byName),
    }))
    .filter((suggestion) => suggestion.people.length > 0)
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate) || a.eventName.localeCompare(b.eventName) || a.itemName.localeCompare(b.itemName));
}

/**
 * The director's confirmation of one event patch (#532): only the chosen
 * members, and only members who attended. The item must be linked to the
 * event, and everyone must be in that event's attendee set for this club
 * (`NOT_SUGGESTED` otherwise, and nothing is added). Needs are keyed on
 * event, member and item, so a double tap adds each once.
 */
export async function confirmEventPatches(
  organizationId: string,
  input: { eventId: string; itemId: string; personIds: readonly string[] },
  actor: ClubOrderActor,
  now = new Date(),
) {
  const personIds = [...new Set(input.personIds)];
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const candidate = (await eventPatchCandidates(tx, organizationId, now, { eventId: input.eventId }))
      .find((entry) => entry.itemId === input.itemId);
    if (!candidate) throw new ClubOrderError("NOT_SUGGESTED", "That item isn't a patch for an event this club attended.");
    const attended = new Set(candidate.personIds);
    if (personIds.some((personId) => !attended.has(personId))) {
      throw new ClubOrderError("NOT_SUGGESTED", "Only members who attended the event can be given its patch.");
    }
    const created = await tx.clubOrderNeed.createMany({
      data: personIds.map((personId) => ({
        organizationId,
        sourceType: "AWARD" as const,
        sourceId: eventPatchSourceId(input.eventId, personId, input.itemId),
        personId,
        itemId: input.itemId,
        sourceLabel: candidate.eventName,
        sourceDate: candidate.eventDate,
      })),
      skipDuplicates: true,
    });
    const skipped = personIds.length - created.count;
    if (created.count > 0) {
      const who = auditActorFields(actor);
      await writeAuditLog({
        ...who.actorFields,
        eventId: input.eventId,
        action: "CLUB_EVENT_PATCHES_CONFIRMED",
        entityType: "ClubOrderNeed",
        summary: `Confirmed ${created.count} event patch${created.count === 1 ? "" : "es"}.`,
        metadata: { organizationId, eventId: input.eventId, itemId: input.itemId, needCount: created.count, skippedCount: skipped, basis: candidate.basis, ...who.metadata },
      }, tx);
    }
    return { created: created.count, skipped };
  });
}

// ---------------------------------------------------------------- Master Awards

type LoadedRule = {
  id: string;
  name: string;
  itemId: string | null;
  groups: Array<{ minimum: number; honorIds: string[] }>;
};

async function activeRules(db: Db, only?: { ruleId: string }): Promise<LoadedRule[]> {
  const rules = await db.masterAwardRule.findMany({
    where: { status: "ACTIVE", ...(only ? { id: only.ruleId } : {}) },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, itemId: true,
      groups: { orderBy: { position: "asc" }, select: { minimum: true, honors: { select: { honorId: true } } } },
    },
  });
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    itemId: rule.itemId,
    groups: rule.groups.map((group) => ({ minimum: group.minimum, honorIds: group.honors.map((honor) => honor.honorId) })),
  }));
}

/**
 * Each person's completed honors (#486): only a person-and-honor's *latest*
 * entry counts, same as the Honors page and the honor order source, so an
 * honor corrected back to in progress no longer counts.
 */
async function completedHonorsByPerson(db: Db, personIds: readonly string[], honorIds: readonly string[]) {
  const completed = new Map<string, Set<string>>();
  if (personIds.length === 0 || honorIds.length === 0) return completed;
  const entries = await db.memberHonorEntry.findMany({
    where: { personId: { in: [...personIds] }, honorId: { in: [...honorIds] }, void: null },
    orderBy: { seq: "desc" },
    select: { personId: true, honorId: true, status: true },
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.personId}\u0000${entry.honorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.status !== "COMPLETED") continue;
    const set = completed.get(entry.personId) ?? new Set<string>();
    set.add(entry.honorId);
    completed.set(entry.personId, set);
  }
  return completed;
}

export type MasterAwardPerson = { personId: string; firstName: string; lastName: string };

export type MasterAwardProgressRow = {
  ruleId: string;
  name: string;
  /** "3 of 7 + 2 of 5 + 2 of 5": the group minimums, for the rule's own line. */
  requirement: string;
  /** No catalog item is linked to this rule, so it can't be added to an order yet. */
  missingItem: boolean;
  /** Reached every group's minimum and not yet on the order list or awarded. */
  eligible: MasterAwardPerson[];
  /** Reached the minimums and is already needed, ordered, or received. */
  onOrder: MasterAwardPerson[];
  /**
   * Reached the minimums, but this award's need already exists under another
   * club (a transferred member): keyed on member and rule across all clubs, so
   * it can't be added again here. Shown as "Already given (another club)".
   */
  givenElsewhere: MasterAwardPerson[];
  awardedCount: number;
  /** The members closest to it, not yet eligible: "5 of 7". */
  closest: Array<MasterAwardPerson & { counted: number; required: number; label: string }>;
};

const CLOSEST_LIMIT = 8;

/**
 * Master Award progress for this club's active members (#532), worked out
 * from the stored ACTIVE rules and each member's latest COMPLETED honors.
 * Reads only. Names and counts, never anything else about a member.
 */
export async function loadMasterAwardProgress(
  organizationId: string,
  now = new Date(),
  /**
   * `personIds` replaces the current club year's active roster (an export for another club year);
   * `closestLimit` replaces the screen's cut-off of the members closest to an award.
   */
  options: { personIds?: readonly string[]; closestLimit?: number } = {},
): Promise<MasterAwardProgressRow[]> {
  const db = getPrisma();
  const rules = await activeRules(db);
  if (rules.length === 0) return [];
  const personIds = options.personIds ? [...new Set(options.personIds)] : await activeMemberIds(db, organizationId, now);
  if (personIds.length === 0) return rules.map((rule) => emptyRow(rule));
  const closestLimit = options.closestLimit ?? CLOSEST_LIMIT;
  const honorIds = [...new Set(rules.flatMap((rule) => rule.groups.flatMap((group) => group.honorIds)))];
  const [completed, names, needs, keyed] = await Promise.all([
    completedHonorsByPerson(db, personIds, honorIds),
    nameMap(db, personIds),
    db.clubOrderNeed.findMany({
      where: { organizationId, sourceType: "AWARD", personId: { in: personIds }, itemId: { in: rules.flatMap((rule) => (rule.itemId ? [rule.itemId] : [])) } },
      select: { personId: true, itemId: true, status: true },
    }),
    // The need key is unique across every club, so a member's Master Award recorded by a
    // previous club counts too (the club-scoped query above can't see it).
    db.clubOrderNeed.findMany({
      where: { sourceType: "AWARD", sourceId: { in: rules.flatMap((rule) => personIds.map((personId) => masterAwardSourceId(personId, rule.id))) } },
      select: { sourceId: true },
    }),
  ]);
  const keyedIds = new Set(keyed.map((need) => need.sourceId));
  const standing = new Map<string, "AWARDED" | "OPEN">();
  for (const need of needs) {
    const key = `${need.personId}\u0000${need.itemId}`;
    if (standing.get(key) === "AWARDED") continue;
    standing.set(key, need.status === "AWARDED" ? "AWARDED" : "OPEN");
  }
  const person = (personId: string): MasterAwardPerson => ({ personId, firstName: names.get(personId)?.firstName ?? "", lastName: names.get(personId)?.lastName ?? "" });
  return rules.map((rule): MasterAwardProgressRow => {
    const row = emptyRow(rule);
    for (const personId of personIds) {
      const progress = evaluateMasterAward(rule, completed.get(personId) ?? new Set());
      const state = rule.itemId ? standing.get(`${personId}\u0000${rule.itemId}`) : undefined;
      if (state === "AWARDED") {
        row.awardedCount += 1;
      } else if (progress.earned) {
        if (state === "OPEN") row.onOrder.push(person(personId));
        else if (keyedIds.has(masterAwardSourceId(personId, rule.id))) row.givenElsewhere.push(person(personId));
        else row.eligible.push(person(personId));
      } else if (progress.counted > 0) {
        row.closest.push({ ...person(personId), counted: progress.counted, required: progress.required, label: progressLabel(progress) });
      }
    }
    row.eligible.sort(byName);
    row.onOrder.sort(byName);
    row.givenElsewhere.sort(byName);
    row.closest.sort((a, b) => b.counted / b.required - a.counted / a.required || byName(a, b));
    row.closest = row.closest.slice(0, closestLimit);
    return row;
  });
}

function emptyRow(rule: LoadedRule): MasterAwardProgressRow {
  return {
    ruleId: rule.id,
    name: rule.name,
    requirement: rule.groups.map((group) => `${group.minimum} of ${new Set(group.honorIds).size}`).join(" + "),
    missingItem: rule.itemId === null,
    eligible: [],
    onOrder: [],
    givenElsewhere: [],
    awardedCount: 0,
    closest: [],
  };
}

/**
 * Adds a Master Award for members who reached it (#532), on the director's
 * confirmation. Eligibility is recomputed here from the stored rule and the
 * members' latest COMPLETED honors: everyone chosen must have reached every
 * group's minimum (`NOT_ELIGIBLE` otherwise, and nothing is added). The rule
 * must be ACTIVE and linked to a catalog item. A member who already has the
 * award (needed, ordered, received, or awarded) is skipped. Keyed on member
 * and rule, so a double tap adds each once.
 */
export async function addMasterAwardNeeds(
  organizationId: string,
  input: { ruleId: string; personIds: readonly string[] },
  actor: ClubOrderActor,
  now = new Date(),
) {
  const personIds = [...new Set(input.personIds)];
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const rule = (await activeRules(tx, { ruleId: input.ruleId }))[0];
    if (!rule) throw new ClubOrderError("NOT_ELIGIBLE", "That Master Award isn't active yet.");
    if (!rule.itemId) throw new ClubOrderError("RULE_HAS_NO_ITEM", "That Master Award isn't linked to a catalog item yet. Conference staff can link it.");
    const item = await tx.clubSupplyItem.findFirst({ where: { id: rule.itemId, isActive: true }, select: { id: true, name: true } });
    if (!item) throw new ClubOrderError("ITEM_NOT_ORDERABLE", "That Master Award's catalog item isn't active.");
    await requireActiveMembers(tx, organizationId, personIds, now);
    const completed = await completedHonorsByPerson(tx, personIds, [...new Set(rule.groups.flatMap((group) => group.honorIds))]);
    if (personIds.some((personId) => !evaluateMasterAward(rule, completed.get(personId) ?? new Set()).earned)) {
      throw new ClubOrderError("NOT_ELIGIBLE", "Everyone must have reached all of the award's requirements.");
    }
    const [have, keyed] = await Promise.all([
      tx.clubOrderNeed.findMany({
        where: { organizationId, sourceType: "AWARD", personId: { in: personIds }, itemId: item.id, status: { in: [...OPEN_STATUSES, "AWARDED"] } },
        select: { personId: true },
      }),
      // The key is unique across all clubs: a Master Award already recorded by another club (a transfer) is skipped, not re-added.
      tx.clubOrderNeed.findMany({
        where: { sourceType: "AWARD", sourceId: { in: personIds.map((personId) => masterAwardSourceId(personId, rule.id)) } },
        select: { personId: true },
      }),
    ]);
    const skipIds = new Set([...have, ...keyed].map((need) => need.personId));
    const data = personIds.filter((personId) => !skipIds.has(personId)).map((personId) => ({
      organizationId,
      sourceType: "AWARD" as const,
      sourceId: masterAwardSourceId(personId, rule.id),
      personId,
      itemId: item.id,
      sourceLabel: rule.name,
      sourceDate: calendarDate(now),
    }));
    const created = data.length === 0 ? { count: 0 } : await tx.clubOrderNeed.createMany({ data, skipDuplicates: true });
    const skipped = personIds.length - created.count;
    if (created.count > 0) {
      const who = auditActorFields(actor);
      await writeAuditLog({
        ...who.actorFields,
        action: "CLUB_MASTER_AWARD_NEEDS_ADDED",
        entityType: "ClubOrderNeed",
        summary: `Added ${created.count} Master Award${created.count === 1 ? "" : "s"} to the order list.`,
        metadata: { organizationId, ruleId: rule.id, itemId: item.id, needCount: created.count, skippedCount: skipped, ...who.metadata },
      }, tx);
    }
    return { created: created.count, skipped };
  });
}

// ---------------------------------------------------------------- workspace

export type AwardCatalogItem = { itemId: string; section: string; sectionLabel: string; name: string; catalogNumber: string | null };

export type AwardNeedRow = {
  needId: string;
  personId: string;
  firstName: string;
  lastName: string;
  itemName: string;
  /** Where the item came from, in words: class insignia, event patch, Master Award, or added by hand. */
  origin: AwardOrigin;
  /** No AdventSource number (conference-made): flagged, not dropped. */
  missingCatalogNumber: boolean;
  status: "NEEDED" | "ORDERED" | "RECEIVED";
  /** True when the person has moved to another club (#791): no class history link. */
  classHistoryHidden?: boolean;
};

export type EarnedAwardsWorkspaceData = {
  /** Hand-pickable catalog items (Good Conduct, TLT, insignia, patches). Empty for a view-only visit. */
  catalog: AwardCatalogItem[];
  /** Active members of this club this year, names and current class only. Empty for a view-only visit. */
  members: AwardMember[];
  /** Open earned items (needed, ordered, received), names and the item only. */
  needs: AwardNeedRow[];
  /** How many earned items have been awarded in all. */
  awardedCount: number;
  /** Suggestions are for editors only: a view-only visit never sees a confirm control. */
  insignia: InsigniaSuggestion[];
  patches: PatchSuggestion[];
  masterAwards: MasterAwardProgressRow[];
};

/**
 * The Earned awards screen's data (#532). Names, item names and statuses
 * only; no birth date, contact or medical field is ever loaded. The picker,
 * member list and suggestions (`forEditing`) are only for a director or
 * deputy; a registrar or Area Coordinator reads the open items and Master
 * Award progress. An editor's load drops departed members' NEEDED needs
 * first; a view-only load writes nothing.
 */
export async function loadEarnedAwardsWorkspace(
  organizationId: string,
  { forEditing }: { forEditing: boolean },
  now = new Date(),
): Promise<EarnedAwardsWorkspaceData> {
  if (forEditing) await removeDepartedMemberNeeds(organizationId, now);
  const prisma = getPrisma();
  const [needs, awardedCount, catalogRows, roster, insignia, patches, masterAwards] = await Promise.all([
    prisma.clubOrderNeed.findMany({
      where: { organizationId, sourceType: "AWARD", status: { in: [...OPEN_STATUSES] }, itemId: { not: null } },
      select: {
        id: true, sourceId: true, status: true, personId: true,
        item: { select: { name: true, catalogNumber: true } },
        person: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.clubOrderNeed.count({ where: { organizationId, sourceType: "AWARD", status: "AWARDED" } }),
    forEditing
      ? prisma.clubSupplyItem.findMany({
        where: { isActive: true, section: { in: [...AWARD_SECTIONS] } },
        orderBy: [{ section: "asc" }, { name: "asc" }],
        select: { id: true, section: true, name: true, catalogNumber: true },
      })
      : Promise.resolve([]),
    forEditing
      ? prisma.clubRosterMember.findMany({
        where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { not: null } },
        select: { classLevel: true, person: { select: { id: true, firstName: true, lastName: true } } },
      })
      : Promise.resolve([]),
    forEditing ? listInsigniaSuggestions(organizationId, now) : Promise.resolve([]),
    forEditing ? listPatchSuggestions(organizationId, now) : Promise.resolve([]),
    loadMasterAwardProgress(organizationId, now),
  ]);
  const movedAway = await personIdsMovedToOtherClubs(organizationId, needs.map((need) => need.personId), now);
  const rows = needs
    .map((need): AwardNeedRow => ({
      ...(movedAway.has(need.personId) ? { classHistoryHidden: true } : {}),
      needId: need.id,
      personId: need.personId,
      firstName: need.person.firstName,
      lastName: need.person.lastName,
      itemName: need.item!.name,
      origin: originOf(need.sourceId),
      missingCatalogNumber: !need.item!.catalogNumber,
      status: need.status as AwardNeedRow["status"],
    }))
    .sort((a, b) => byName(a, b) || a.itemName.localeCompare(b.itemName));
  const members = [...new Map(roster.flatMap((row) => (row.person ? [[row.person.id, {
    personId: row.person.id,
    firstName: row.person.firstName,
    lastName: row.person.lastName,
    classLabel: row.classLevel ? clubClassLevelLabels[row.classLevel] : "",
  }] as const] : []))).values()].sort(byName);
  return {
    catalog: catalogRows.map((row) => ({
      itemId: row.id,
      section: row.section,
      sectionLabel: clubSupplySectionLabels[row.section],
      name: row.name,
      catalogNumber: row.catalogNumber,
    })),
    members,
    needs: rows,
    awardedCount,
    insignia,
    patches,
    masterAwards,
  };
}

// ---------------------------------------------------------------- class history

/**
 * Which of these people have moved to another club (#791), in bulk. "Moved"
 * is how a transfer (#489) lands: a current-year roster row that is not
 * removed in a different club. A person who is also still a current,
 * non-removed member of this club has not moved away from it. Reads only.
 */
export async function personIdsMovedToOtherClubs(organizationId: string, personIds: readonly string[], now = new Date()): Promise<Set<string>> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return new Set();
  const rows = await getPrisma().clubRosterMember.findMany({
    where: { clubYear: clubYearFor(now), status: { not: "REMOVED" }, personId: { in: ids } },
    select: { organizationId: true, personId: true },
  });
  const here = new Set(rows.filter((row) => row.organizationId === organizationId).map((row) => row.personId));
  return new Set(rows.flatMap((row) => (row.personId && row.organizationId !== organizationId && !here.has(row.personId) ? [row.personId] : [])));
}

export type MemberClassHistory = { personId: string; firstName: string; lastName: string; entries: ClassHistoryEntry[] };

/**
 * One member's class history (#791): recorded completions and the current
 * class, names and class levels only. Reads only; the caller passes the
 * class-tracking gate first. `null` when the person was never on this club's
 * roster, so another club's member is never shown.
 */
export async function loadMemberClassHistory(organizationId: string, personId: string, now = new Date()): Promise<MemberClassHistory | null> {
  const prisma = getPrisma();
  const [rosterRows, completions, moved] = await Promise.all([
    prisma.clubRosterMember.findMany({
      where: { organizationId, personId, status: { not: "REMOVED" } },
      orderBy: { clubYear: "desc" },
      select: { clubYear: true, classLevel: true, status: true, person: { select: { firstName: true, lastName: true } } },
    }),
    prisma.memberClassCompletion.findMany({ where: { organizationId, personId }, select: { classLevel: true, completedOn: true } }),
    personIdsMovedToOtherClubs(organizationId, [personId], now),
  ]);
  const person = rosterRows[0]?.person;
  if (!person) return null;
  // A former member who is now on another club's roster is that club's to see, not this one's (#791).
  if (moved.has(personId)) return null;
  const current = rosterRows.find((row) => row.clubYear === clubYearFor(now) && row.status === "ACTIVE");
  return {
    personId,
    firstName: person.firstName,
    lastName: person.lastName,
    entries: buildClassHistory(completions, current?.classLevel ?? null),
  };
}
