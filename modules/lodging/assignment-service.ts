import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  assignableRegistrationStatuses,
  assignmentActionSchema,
  assignmentEventLabels,
  assignmentSettingsSchema,
  bucketRenameSchema,
  parseAssignmentCsv,
  placeholderActionSchema,
  planCancellation,
  planPlacements,
  planPlacementsLenient,
  planRequestSchema,
  planStayChange,
  planTransfer,
  proposeAssignments,
  MAX_IMPORT_ROWS,
  type AssignmentAction,
  type AssignmentSource,
  type OccupantInput,
  type PlacementProblem,
  type Plan,
  type PlanPlacement,
  type ProposalPerson,
  type ProposalUnit,
  type Segment,
} from "@/modules/lodging/assignment-domain";
import { LodgingError, type LodgingErrorCode } from "@/modules/lodging/errors";
import { requestNights } from "@/modules/lodging/preferences-domain";
import {
  attendeeName,
  loadCurrentRequests,
  type Client,
  type Tx,
} from "@/modules/lodging/preferences-service";
import { lockEventLodgingUnits, lodgingTransactionTimeoutMs, touchEventLodgingCapacity } from "@/modules/lodging/service";
import { parseCsvMatrix, CsvImportError } from "@/modules/imports/csv-parser";
import { loadPlanningState, loadTogetherInput, toDate, type PlanningState } from "@/modules/lodging/assignment-state";

/**
 * Lodging assignment writers (#200, slice 3).
 *
 * Every writer: takes the `EventLodgingUnit` row locks for the event's whole lodging (in id order, through
 * `lockEventLodgingUnits`, the same lock the registration submission and every capacity writer takes), bumps
 * `capacityVersion` (`touchEventLodgingCapacity`, after the locks, so a Serializable registration submission that
 * read capacity first is retried), then reads the current assignments and plans against them, night by night. Two
 * staff members racing for the last bed therefore leave one winner. The writers never touch a registration's
 * charge, send nothing, and write the audit log without names.
 */

export type AssignmentRow = Prisma.EventLodgingAssignmentGetPayload<Record<string, never>>;

const problemCodes: Record<PlacementProblem["code"], LodgingErrorCode> = {
  DATES_OUTSIDE_EVENT: "DATES_OUTSIDE_EVENT_NIGHTS",
  ALREADY_ASSIGNED: "ALREADY_ASSIGNED",
  UNIT_OUT_OF_SERVICE: "UNIT_OUT_OF_SERVICE",
  UNIT_FULL: "UNIT_FULL",
  SPECIAL_USE_UNCONFIRMED: "SPECIAL_USE_UNCONFIRMED",
  UNKNOWN_PLACE: "UNKNOWN_PLACE",
};

function problemError(problem: PlacementProblem, prefix = "") {
  return new LodgingError(problemCodes[problem.code], `${prefix}${problem.message}`);
}

/** The exclusion constraint on an occupant's night ranges: two placements raced for the same person. */
function isOccupantOverlap(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("EventLodgingAssignment_occupant_nights") || message.includes("23P01");
}

// ---------------------------------------------------------------------------
// Planning state, read under the locks
// ---------------------------------------------------------------------------

/** Takes the locks every capacity writer takes (all unit rows, then the capacity version) and reads what is current. */
async function lockedState(tx: Tx, eventId: string) {
  const lodging = await tx.eventLodging.findUnique({ where: { eventId }, select: { id: true } });
  if (!lodging) throw new LodgingError("NO_PROPERTY", "Choose a lodging property for this event first.");
  const rows = await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: lodging.id }, select: { id: true } });
  await lockEventLodgingUnits(tx, eventId, rows.map((row) => row.id));
  await touchEventLodgingCapacity(tx, lodging.id);
  return loadPlanningState(tx, eventId);
}

// ---------------------------------------------------------------------------
// Occupants
// ---------------------------------------------------------------------------

export type ResolvedOccupant = {
  ref: OccupantInput;
  occupantKey: string;
  attendeeId: string | null;
  placeholderId: string | null;
  people: number;
  registrationId: string | null;
  registrationStatus: string | null;
  name: string;
};

const occupantRefKey = (ref: OccupantInput) => `${ref.kind}:${ref.id}`;

export async function resolveOccupants(client: Client, eventId: string, refs: readonly OccupantInput[]) {
  const attendeeIds = [...new Set(refs.filter((ref) => ref.kind === "ATTENDEE").map((ref) => ref.id))];
  const placeholderIds = [...new Set(refs.filter((ref) => ref.kind === "PLACEHOLDER").map((ref) => ref.id))];
  const [attendees, placeholders] = await Promise.all([
    attendeeIds.length === 0 ? [] : client.registrationAttendee.findMany({
      where: { id: { in: attendeeIds }, eventId },
      select: { id: true, registrationId: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } }, registration: { select: { status: true } } },
    }),
    placeholderIds.length === 0 ? [] : client.eventLodgingPlaceholder.findMany({ where: { id: { in: placeholderIds }, eventId } }),
  ]);
  const result = new Map<string, ResolvedOccupant>();
  for (const attendee of attendees) {
    result.set(`ATTENDEE:${attendee.id}`, {
      ref: { kind: "ATTENDEE", id: attendee.id }, occupantKey: attendee.id, attendeeId: attendee.id, placeholderId: null, people: 1,
      registrationId: attendee.registrationId, registrationStatus: attendee.registration.status, name: attendeeName(attendee),
    });
  }
  for (const placeholder of placeholders) {
    result.set(`PLACEHOLDER:${placeholder.id}`, {
      ref: { kind: "PLACEHOLDER", id: placeholder.id },
      // A linked placeholder is the attendee from then on.
      occupantKey: placeholder.linkedAttendeeId ?? placeholder.id,
      attendeeId: placeholder.linkedAttendeeId,
      placeholderId: placeholder.id,
      people: placeholder.headcount,
      registrationId: null,
      registrationStatus: null,
      name: placeholder.displayName,
    });
  }
  for (const ref of refs) {
    if (!result.has(occupantRefKey(ref))) throw new LodgingError(ref.kind === "ATTENDEE" ? "OCCUPANT_NOT_FOUND" : "PLACEHOLDER_NOT_FOUND", "That person was not found for this event.");
  }
  return result;
}

function assertCanBePlaced(occupant: ResolvedOccupant, archived: ReadonlySet<string>) {
  if (occupant.ref.kind === "PLACEHOLDER") {
    if (occupant.attendeeId) throw new LodgingError("PLACEHOLDER_LINKED", "That expected guest is now a registered attendee. Place the attendee instead.");
    if (archived.has(occupant.ref.id)) throw new LodgingError("PLACEHOLDER_NOT_FOUND", "That expected guest was archived.");
    return;
  }
  if (!(assignableRegistrationStatuses as readonly string[]).includes(occupant.registrationStatus ?? "")) {
    throw new LodgingError("REGISTRATION_NOT_ACTIVE", `${occupant.name}'s registration is not submitted or confirmed, so they cannot be placed.`);
  }
}

async function archivedPlaceholders(client: Client, eventId: string) {
  const rows = await client.eventLodgingPlaceholder.findMany({ where: { eventId, archivedAt: { not: null } }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

// ---------------------------------------------------------------------------
// Writing a plan
// ---------------------------------------------------------------------------

export type PlanMeta = { eventId: string; actorUserId: string; reason: string; source: AssignmentSource; state: PlanningState };

export type PlanOutcome = { created: number; released: number; noted: number; unchanged: number; assignmentIds: string[]; attendeeIds: string[] };

/**
 * Writes the rows a plan names, in an order the database's exclusion constraint accepts (releases before creates), and
 * appends one history row for every change (the database insists on it at commit). Returns what changed.
 */
export async function writePlan(tx: Tx, plan: Plan, meta: PlanMeta): Promise<PlanOutcome> {
  const { eventId, actorUserId, reason, state } = meta;
  const rows = new Map(state.rowsById);
  const keyToId = new Map<string, string>();
  for (const create of plan.creates) keyToId.set(create.key, randomUUID());
  const pending: Prisma.EventLodgingAssignmentHistoryCreateManyInput[] = [];
  const touchedAttendees = new Set<string>();
  const now = new Date();
  const placeOf = (segment: Pick<Segment, "unitId" | "bucketId">) => ({ eventLodgingUnitId: segment.unitId, bucketId: segment.bucketId });

  for (const release of plan.releases) {
    const row = rows.get(release.id);
    if (!row) throw new LodgingError("ASSIGNMENT_NOT_FOUND", "That assignment changed while you were working. Refresh and try again.");
    const revision = row.revision + 1;
    const cancelReason = `${assignmentEventLabels[release.type]}: ${reason}`.slice(0, 300);
    const updated = await tx.eventLodgingAssignment.update({
      where: { id: row.id },
      data: release.after
        ? { firstNight: toDate(release.after.firstNight), lastNight: toDate(release.after.lastNight), revision, actorUserId }
        : { cancelledAt: now, cancelledByUserId: actorUserId, cancelReason, revision, actorUserId },
    });
    // A plan can release the same row twice (two moves of one stay): the next release builds on this revision.
    rows.set(row.id, updated);
    if (row.attendeeId) touchedAttendees.add(row.attendeeId);
    pending.push({
      eventId, assignmentId: row.id, type: release.type, at: now, actorUserId, reason, source: meta.source,
      attendeeId: row.attendeeId, placeholderId: row.placeholderId, people: row.people,
      ...placeOf(release.before),
      firstNight: toDate((release.after ?? release.before).firstNight), lastNight: toDate((release.after ?? release.before).lastNight),
      previousUnitId: release.before.unitId, previousBucketId: release.before.bucketId,
      previousFirstNight: toDate(release.before.firstNight), previousLastNight: toDate(release.before.lastNight),
      revision, relatedAssignmentId: release.relatedKey ? keyToId.get(release.relatedKey) ?? null : null,
    });
  }

  for (const create of plan.creates) {
    const id = keyToId.get(create.key)!;
    const origin = create.relatedId ? rows.get(create.relatedId) : undefined;
    const occupant = create.type === "SPLIT_REMAINDER" && origin
      ? { attendeeId: origin.attendeeId, placeholderId: origin.placeholderId }
      : create.occupant;
    const source = create.type === "SPLIT_REMAINDER" && origin ? origin.source : create.source;
    await tx.eventLodgingAssignment.create({
      data: {
        id, eventId,
        eventLodgingUnitId: create.segment.unitId, bucketId: create.segment.bucketId,
        attendeeId: occupant.attendeeId, placeholderId: occupant.placeholderId,
        people: create.segment.people,
        firstNight: toDate(create.segment.firstNight), lastNight: toDate(create.segment.lastNight),
        source, revision: 1, reason, actorUserId,
      },
    });
    if (occupant.attendeeId) touchedAttendees.add(occupant.attendeeId);
    pending.push({
      eventId, assignmentId: id, type: create.type, at: now, actorUserId, reason, source,
      attendeeId: occupant.attendeeId, placeholderId: occupant.placeholderId, people: create.segment.people,
      ...placeOf(create.segment),
      firstNight: toDate(create.segment.firstNight), lastNight: toDate(create.segment.lastNight),
      previousUnitId: create.previous?.unitId ?? null, previousBucketId: create.previous?.bucketId ?? null,
      previousFirstNight: create.previous ? toDate(create.previous.firstNight) : null,
      previousLastNight: create.previous ? toDate(create.previous.lastNight) : null,
      revision: 1, relatedAssignmentId: create.relatedId ? (create.relatedId.startsWith("new:") ? keyToId.get(create.relatedId) ?? null : create.relatedId) : null,
    });
  }

  for (const note of plan.notes) {
    const row = rows.get(note.id);
    if (!row) continue;
    if (row.attendeeId) touchedAttendees.add(row.attendeeId);
    pending.push({
      eventId, assignmentId: row.id, type: note.type, at: now, actorUserId, reason, source: meta.source,
      attendeeId: row.attendeeId, placeholderId: row.placeholderId, people: row.people,
      ...placeOf(note.before), firstNight: toDate(note.before.firstNight), lastNight: toDate(note.before.lastNight),
      preservedCapacity: true, revision: row.revision,
    });
  }

  if (pending.length > 0) await tx.eventLodgingAssignmentHistory.createMany({ data: pending });
  return {
    created: plan.creates.length,
    released: plan.releases.length,
    noted: plan.notes.length,
    unchanged: plan.unchanged,
    assignmentIds: [...plan.creates.map((create) => keyToId.get(create.key)!), ...plan.releases.map((release) => release.id)],
    attendeeIds: [...touchedAttendees],
  };
}

/**
 * A room notice that has not been delivered yet is cancelled when a later change makes it wrong: the outbox row stays,
 * marked cancelled, and the staff view lists the notice as out of date. One already delivered stays as sent history.
 */
export async function supersedePendingNotices(tx: Tx, eventId: string, attendeeIds: readonly string[]) {
  if (attendeeIds.length === 0) return 0;
  const attendees = await tx.registrationAttendee.findMany({ where: { id: { in: [...attendeeIds] }, eventId }, select: { registrationId: true } });
  const registrationIds = [...new Set(attendees.map((attendee) => attendee.registrationId))];
  if (registrationIds.length === 0) return 0;
  const notices = await tx.eventLodgingAssignmentNotice.findMany({ where: { eventId, registrationId: { in: registrationIds }, outboxMessageId: { not: null } }, select: { outboxMessageId: true } });
  const messageIds = notices.map((notice) => notice.outboxMessageId!).filter(Boolean);
  if (messageIds.length === 0) return 0;
  const result = await tx.messageOutbox.updateMany({
    where: { id: { in: messageIds }, status: "PENDING" },
    data: { status: "CANCELLED", lastError: "A later room change made this notice out of date before it was sent." },
  });
  return result.count;
}

export type AssignmentResult = PlanOutcome & { cancelledNotices: number };

export async function finishPlan(tx: Tx, meta: PlanMeta, plan: Plan, summary: string, auditAction: string, extra: Record<string, unknown> = {}): Promise<AssignmentResult> {
  const outcome = await writePlan(tx, plan, meta);
  const cancelledNotices = await supersedePendingNotices(tx, meta.eventId, outcome.attendeeIds);
  if (outcome.created + outcome.released + outcome.noted > 0) {
    await writeAuditLog({
      eventId: meta.eventId, actorUserId: meta.actorUserId, action: auditAction, entityType: "EventLodgingAssignment",
      summary: summary,
      metadata: { created: outcome.created, released: outcome.released, noted: outcome.noted, unchanged: outcome.unchanged, source: meta.source, assignmentIds: outcome.assignmentIds.slice(0, 50), cancelledNotices, ...extra },
    }, tx);
  }
  return { ...outcome, cancelledNotices };
}

function wrapOverlap<T>(promise: Promise<T>) {
  return promise.catch((error: unknown) => {
    if (isOccupantOverlap(error)) throw new LodgingError("ALREADY_ASSIGNED", "That person was placed somewhere else for some of those nights at the same moment. Refresh and look again.");
    throw error;
  });
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

function toPlanPlacements(
  placements: ReadonlyArray<{ occupant: OccupantInput; place: { kind: "UNIT"; eventUnitId: string } | { kind: "BUCKET"; bucketId: string }; firstNight: string; lastNight: string; mode: "ASSIGN" | "MOVE"; confirmSpecialUse: boolean }>,
  occupants: ReadonlyMap<string, ResolvedOccupant>,
  source: AssignmentSource,
): PlanPlacement[] {
  return placements.map((placement) => {
    const occupant = occupants.get(occupantRefKey(placement.occupant))!;
    return {
      occupantKey: occupant.occupantKey,
      occupant: { attendeeId: occupant.attendeeId, placeholderId: occupant.ref.kind === "PLACEHOLDER" ? occupant.placeholderId : null },
      people: occupant.people,
      place: placement.place.kind === "UNIT" ? { unitId: placement.place.eventUnitId } : { bucketId: placement.place.bucketId },
      firstNight: placement.firstNight,
      lastNight: placement.lastNight,
      mode: placement.mode,
      confirmSpecialUse: placement.confirmSpecialUse,
      source,
    };
  });
}

const sourceReason: Record<AssignmentSource, string> = {
  STAFF: "Assigned by staff",
  PROPOSAL: "Rule-assisted proposal applied by staff",
  CSV_IMPORT: "CSV import confirmed by staff",
  WAITLIST: "Placed from the lodging waitlist",
};

/**
 * Staff assignment actions (MANAGE_REGISTRATION, checked by the caller): place, move, cancel, late arrival and early
 * departure, transfer, and release the rooms of registrations that are no longer active. Each change keeps who did it
 * and why, never overwrites an earlier history row, and releases or keeps capacity as the staff member chose.
 */
export async function applyAssignmentAction(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()): Promise<AssignmentResult> {
  const input: AssignmentAction = assignmentActionSchema.parse(rawInput);
  return wrapOverlap(client.$transaction(async (tx) => {
    const state = await lockedState(tx, eventId);
    const eventNights = state.context.nights;
    const base = { eventId, actorUserId, state };
    if (input.action === "place") {
      const refs = input.placements.map((placement) => placement.occupant);
      const occupants = await resolveOccupants(tx, eventId, refs);
      const archived = await archivedPlaceholders(tx, eventId);
      for (const occupant of occupants.values()) assertCanBePlaced(occupant, archived);
      const result = planPlacements({ segments: state.segments, units: state.units, buckets: state.bucketIds, eventNights, placements: toPlanPlacements(input.placements, occupants, "STAFF") });
      if (!result.ok) {
        const who = occupants.get(occupantRefKey(input.placements[result.index]!.occupant))?.name;
        throw problemError(result.problem, input.placements.length > 1 && who ? `${who}: ` : "");
      }
      if (result.plan.releases.length > 0 && !input.reason) throw new LodgingError("REASON_REQUIRED", "Give a reason for the move.");
      const reason = input.reason || sourceReason.STAFF;
      return finishPlan(tx, { ...base, reason, source: "STAFF" }, result.plan, `Placed ${result.plan.creates.length} ${result.plan.creates.length === 1 ? "person" : "people"} in lodging.`, "LODGING_ASSIGNMENT_PLACED");
    }
    if (input.action === "cancel") {
      const row = state.rowsById.get(input.assignmentId);
      if (!row) throw new LodgingError("ASSIGNMENT_NOT_FOUND", "That assignment was not found, or it was already cancelled.");
      const cut = input.firstNight && input.lastNight ? { firstNight: input.firstNight, lastNight: input.lastNight } : null;
      if ((input.firstNight === undefined) !== (input.lastNight === undefined)) throw new LodgingError("DATES_OUTSIDE_EVENT_NIGHTS", "Give both nights or neither.");
      const plan = planCancellation(state.segments, input.assignmentId, cut);
      if (!plan) throw new LodgingError("ASSIGNMENT_NOT_FOUND", "That assignment was not found, or it was already cancelled.");
      return finishPlan(tx, { ...base, reason: input.reason, source: "STAFF" }, plan, "Cancelled a lodging assignment.", "LODGING_ASSIGNMENT_CANCELLED");
    }
    if (input.action === "stay_change") {
      const occupants = await resolveOccupants(tx, eventId, [input.occupant]);
      const occupant = occupants.get(occupantRefKey(input.occupant))!;
      const own = state.segments.filter((segment) => segment.occupantKey === occupant.occupantKey);
      if (own.length === 0) throw new LodgingError("ASSIGNMENT_NOT_FOUND", `${occupant.name} is not placed anywhere.`);
      const plan = planStayChange(own, input.kind, input.night, input.keepCapacity);
      if (plan.releases.length === 0 && plan.notes.length === 0) throw new LodgingError("DATES_OUTSIDE_EVENT_NIGHTS", "That change does not shorten the stay.");
      return finishPlan(tx, { ...base, reason: input.reason, source: "STAFF" }, { ...plan, after: plan.after }, input.kind === "LATE_ARRIVAL" ? "Recorded a late arrival." : "Recorded an early departure.", input.kind === "LATE_ARRIVAL" ? "LODGING_LATE_ARRIVAL" : "LODGING_EARLY_DEPARTURE", { keepCapacity: input.keepCapacity });
    }
    if (input.action === "transfer") {
      const row = state.rowsById.get(input.assignmentId);
      if (!row) throw new LodgingError("ASSIGNMENT_NOT_FOUND", "That assignment was not found, or it was already cancelled.");
      const occupants = await resolveOccupants(tx, eventId, [input.to]);
      const target = occupants.get(occupantRefKey(input.to))!;
      assertCanBePlaced(target, await archivedPlaceholders(tx, eventId));
      const result = planTransfer({
        segments: state.segments, segmentId: input.assignmentId,
        to: { occupantKey: target.occupantKey, attendeeId: target.attendeeId, placeholderId: target.ref.kind === "PLACEHOLDER" ? target.placeholderId : null, people: target.people },
        units: state.units, buckets: state.bucketIds, eventNights, confirmSpecialUse: true,
      });
      if (!result.ok) throw problemError(result.problem);
      return finishPlan(tx, { ...base, reason: input.reason, source: "STAFF" }, result.plan, "Transferred a lodging assignment to another person.", "LODGING_ASSIGNMENT_TRANSFERRED");
    }
    // release_inactive: rooms still held by registrations that are no longer submitted or confirmed.
    const inactive = await tx.eventLodgingAssignment.findMany({
      where: { eventId, cancelledAt: null, attendee: { registration: { status: { notIn: [...assignableRegistrationStatuses] } } } },
      select: { id: true },
    });
    if (inactive.length === 0) return { created: 0, released: 0, noted: 0, unchanged: 0, assignmentIds: [], attendeeIds: [], cancelledNotices: 0 };
    const releases = inactive.flatMap((row) => {
      const segment = state.segments.find((candidate) => candidate.id === row.id);
      return segment ? [{ kind: "RELEASE" as const, id: segment.id, type: "CANCELLED" as const, before: segment, after: null }] : [];
    });
    return finishPlan(tx, { ...base, reason: input.reason, source: "STAFF" }, { releases, creates: [], notes: [], unchanged: 0, after: [] }, `Released ${releases.length} assignment(s) of registrations that are no longer active.`, "LODGING_INACTIVE_RELEASED");
  }, { timeout: lodgingTransactionTimeoutMs }));
}

// ---------------------------------------------------------------------------
// Placeholders (expected guests) and alternate-housing buckets
// ---------------------------------------------------------------------------

export async function applyPlaceholderAction(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = placeholderActionSchema.parse(rawInput);
  return wrapOverlap(client.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw new LodgingError("EVENT_NOT_FOUND", "That event was not found.");
    if (input.action === "create") {
      const created = await tx.eventLodgingPlaceholder.create({
        data: { eventId, displayName: input.displayName, headcount: input.headcount, note: input.note || null, createdByUserId: actorUserId },
      });
      await writeAuditLog({ eventId, actorUserId, action: "LODGING_PLACEHOLDER_CREATED", entityType: "EventLodgingPlaceholder", entityId: created.id, summary: "Added an expected guest to lodging.", metadata: { headcount: input.headcount } }, tx);
      return { id: created.id };
    }
    if (input.action === "archive") {
      const state = await lockedState(tx, eventId);
      const placeholder = await tx.eventLodgingPlaceholder.findFirst({ where: { id: input.placeholderId, eventId } });
      if (!placeholder) throw new LodgingError("PLACEHOLDER_NOT_FOUND", "That expected guest was not found.");
      if (state.assignments.some((row) => row.placeholderId === placeholder.id)) {
        throw new LodgingError("PLACEHOLDER_IN_USE", "That expected guest is still placed. Cancel or transfer the assignment first.");
      }
      if (placeholder.archivedAt) return { id: placeholder.id };
      await tx.eventLodgingPlaceholder.update({ where: { id: placeholder.id }, data: { archivedAt: new Date(), archivedByUserId: actorUserId } });
      await writeAuditLog({ eventId, actorUserId, action: "LODGING_PLACEHOLDER_ARCHIVED", entityType: "EventLodgingPlaceholder", entityId: placeholder.id, summary: "Archived an expected guest.", metadata: {} }, tx);
      return { id: placeholder.id };
    }
    // link: the expected guest is now a registered attendee. Their placements follow, with history.
    const state = await lockedState(tx, eventId);
    const placeholder = await tx.eventLodgingPlaceholder.findFirst({ where: { id: input.placeholderId, eventId } });
    if (!placeholder) throw new LodgingError("PLACEHOLDER_NOT_FOUND", "That expected guest was not found.");
    if (placeholder.linkedAttendeeId) throw new LodgingError("PLACEHOLDER_LINKED", "That expected guest is already linked to a registration.");
    if (placeholder.headcount !== 1) throw new LodgingError("PLACEHOLDER_NOT_LINKABLE", "Only a single expected guest can be linked to a registered person. A group stays a group.");
    const attendee = await tx.registrationAttendee.findFirst({ where: { id: input.attendeeId, eventId }, select: { id: true, registration: { select: { status: true } } } });
    if (!attendee) throw new LodgingError("OCCUPANT_NOT_FOUND", "That attendee was not found for this event.");
    if (!(assignableRegistrationStatuses as readonly string[]).includes(attendee.registration.status)) {
      throw new LodgingError("REGISTRATION_NOT_ACTIVE", "That registration is not submitted or confirmed.");
    }
    const already = await tx.eventLodgingPlaceholder.count({ where: { eventId, linkedAttendeeId: attendee.id } });
    if (already > 0) throw new LodgingError("PLACEHOLDER_LINKED", "Another expected guest is already linked to that attendee.");
    const own = state.assignments.filter((row) => row.placeholderId === placeholder.id);
    const now = new Date();
    await tx.eventLodgingPlaceholder.update({ where: { id: placeholder.id }, data: { linkedAttendeeId: attendee.id, linkedAt: now, linkedByUserId: actorUserId } });
    const history: Prisma.EventLodgingAssignmentHistoryCreateManyInput[] = [];
    for (const row of own) {
      const revision = row.revision + 1;
      await tx.eventLodgingAssignment.update({ where: { id: row.id }, data: { attendeeId: attendee.id, revision, actorUserId } });
      history.push({
        eventId, assignmentId: row.id, type: "LINKED", at: now, actorUserId, reason: input.reason, source: row.source,
        attendeeId: attendee.id, placeholderId: placeholder.id, people: row.people,
        eventLodgingUnitId: row.eventLodgingUnitId, bucketId: row.bucketId, firstNight: row.firstNight, lastNight: row.lastNight, revision,
      });
    }
    if (history.length > 0) await tx.eventLodgingAssignmentHistory.createMany({ data: history });
    const cancelled = await supersedePendingNotices(tx, eventId, [attendee.id]);
    await writeAuditLog({ eventId, actorUserId, action: "LODGING_PLACEHOLDER_LINKED", entityType: "EventLodgingPlaceholder", entityId: placeholder.id, summary: "Linked an expected guest to a registration.", metadata: { assignments: own.length, cancelledNotices: cancelled } }, tx);
    return { id: placeholder.id, assignments: own.length };
  }, { timeout: lodgingTransactionTimeoutMs }));
}

export async function renameBucket(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = bucketRenameSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const bucket = await tx.eventLodgingBucket.findFirst({ where: { id: input.bucketId, eventId } });
    if (!bucket) throw new LodgingError("BUCKET_NOT_FOUND", "That housing choice was not found for this event.");
    if (bucket.label === input.label) return { id: bucket.id, label: bucket.label };
    await tx.eventLodgingBucket.update({ where: { id: bucket.id }, data: { label: input.label, updatedByUserId: actorUserId } });
    await writeAuditLog({ eventId, actorUserId, action: "LODGING_BUCKET_RENAMED", entityType: "EventLodgingBucket", entityId: bucket.id, summary: `Renamed the ${bucket.kind.toLowerCase()} housing choice.`, metadata: { kind: bucket.kind, from: bucket.label, to: input.label } }, tx);
    return { id: bucket.id, label: input.label };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Attendee-display settings (publishing needs MANAGE_REGISTRATION plus CONFIGURE_EVENT; the route checks both)
// ---------------------------------------------------------------------------

export async function updateAssignmentSettings(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = assignmentSettingsSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const lodging = await tx.eventLodging.findUnique({ where: { eventId } });
    if (!lodging) throw new LodgingError("NO_PROPERTY", "Choose a lodging property for this event first.");
    const next = {
      showAssignmentsToAttendees: input.showAssignmentsToAttendees ?? lodging.showAssignmentsToAttendees,
      showRoommateFirstNames: input.showRoommateFirstNames ?? lodging.showRoommateFirstNames,
      attendeeInstructions: input.attendeeInstructions === undefined ? lodging.attendeeInstructions : (input.attendeeInstructions || null),
    };
    // Roommate names make no sense without the assignment they belong to.
    if (!next.showAssignmentsToAttendees) next.showRoommateFirstNames = false;
    const changed = next.showAssignmentsToAttendees !== lodging.showAssignmentsToAttendees
      || next.showRoommateFirstNames !== lodging.showRoommateFirstNames
      || next.attendeeInstructions !== lodging.attendeeInstructions;
    if (changed) {
      await tx.eventLodging.update({ where: { id: lodging.id }, data: { ...next, assignmentSettingsUpdatedByUserId: actorUserId } });
      await writeAuditLog({
        eventId, actorUserId, action: "LODGING_ASSIGNMENT_SETTINGS_CHANGED", entityType: "EventLodging", entityId: lodging.id,
        summary: next.showAssignmentsToAttendees ? "Showed room assignments to attendees." : "Hid room assignments from attendees.",
        metadata: {
          showAssignmentsToAttendees: { from: lodging.showAssignmentsToAttendees, to: next.showAssignmentsToAttendees },
          showRoommateFirstNames: { from: lodging.showRoommateFirstNames, to: next.showRoommateFirstNames },
          instructionsChanged: next.attendeeInstructions !== lodging.attendeeInstructions,
        },
      }, tx);
    }
    return { showAssignmentsToAttendees: next.showAssignmentsToAttendees, showRoommateFirstNames: next.showRoommateFirstNames, attendeeInstructions: next.attendeeInstructions };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Proposal and CSV import: preview first, then a confirmed apply
// ---------------------------------------------------------------------------

export type PlanPreviewRow = {
  line: number | null;
  occupantId: string;
  name: string;
  place: string;
  firstNight: string;
  lastNight: string;
  /** "OK", "MOVE" (replaces nights already placed) or a problem that skips the row. */
  outcome: "NEW" | "MOVE" | "UNCHANGED" | "PROBLEM";
  message: string | null;
};

export type PlanPreview = {
  source: "PROPOSAL" | "CSV_IMPORT";
  fingerprint: string;
  rows: PlanPreviewRow[];
  unplaced: Array<{ occupantId: string; name: string; reason: string }>;
  problems: Array<{ line: number | null; message: string }>;
  counts: { new: number; move: number; unchanged: number; problems: number; unplaced: number };
};

/**
 * A fingerprint of the whole plan, not just what was asked for: every row's outcome, every assignment the plan would
 * release (with the revision it was read at and the range it keeps) and every row it would create. So a colleague's
 * move, cancellation or placement of an affected assignment between preview and apply changes it.
 */
function fingerprintOf(source: string, placements: readonly PlanPlacement[], outcomes: readonly string[], plan: Plan, rowsById: ReadonlyMap<string, AssignmentRow>) {
  const asked = placements.map((placement) => [placement.occupantKey, "unitId" in placement.place ? `u:${placement.place.unitId}` : `b:${placement.place.bucketId}`, placement.firstNight, placement.lastNight, placement.mode, placement.people]);
  const releases = plan.releases.map((release) => [release.id, rowsById.get(release.id)?.revision ?? 0, release.type, release.after ? [release.after.firstNight, release.after.lastNight] : null, release.before.unitId, release.before.bucketId, release.before.firstNight, release.before.lastNight]);
  const creates = plan.creates.map((create) => [create.type, create.segment.occupantKey, create.segment.unitId, create.segment.bucketId, create.segment.people, create.segment.firstNight, create.segment.lastNight, create.relatedId ?? null]);
  return createHash("sha256").update(JSON.stringify([source, asked, outcomes, releases, creates, plan.unchanged])).digest("hex");
}

/** Everyone who could be proposed: active attendees (and unplaced expected guests), with the nights they want. */
async function loadProposalPeople(client: Client, eventId: string, state: PlanningState, canSeeSensitive: boolean) {
  const [registrations, requests, placeholders] = await Promise.all([
    client.registration.findMany({
      where: { eventId, status: { in: [...assignableRegistrationStatuses] } },
      select: { id: true, attendees: { orderBy: [{ position: "asc" }, { id: "asc" }], select: { id: true, personId: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } } } },
    }),
    loadCurrentRequests(client, eventId),
    client.eventLodgingPlaceholder.findMany({ where: { eventId, archivedAt: null, linkedAttendeeId: null } }),
  ]);
  const requestByRegistration = new Map(requests.map((request) => [request.registrationId, request]));
  const people: Array<ProposalPerson & { name: string }> = [];
  for (const registration of registrations) {
    const request = requestByRegistration.get(registration.id);
    // A request with no category means "not asking for lodging": nothing to propose.
    if (request && request.category === null) continue;
    for (const attendee of registration.attendees) {
      people.push({
        occupantKey: attendee.id, occupant: { attendeeId: attendee.id, placeholderId: null }, people: 1,
        registrationId: registration.id, personId: attendee.personId, name: attendeeName(attendee),
        nights: request ? requestNights(request, state.context.nights) : [...state.context.nights],
        category: request?.category ?? null,
        needsGroundFloor: canSeeSensitive && Boolean(request?.groundFloorNeeded || request?.accessibleRoomNeeded),
      });
    }
  }
  for (const placeholder of placeholders) {
    people.push({
      occupantKey: placeholder.id, occupant: { attendeeId: null, placeholderId: placeholder.id }, people: placeholder.headcount,
      registrationId: null, personId: null, name: placeholder.displayName, nights: [...state.context.nights], category: null, needsGroundFloor: false,
    });
  }
  return people.filter((person) => person.nights.length > 0);
}

async function proposalPlacements(client: Client, eventId: string, state: PlanningState, canSeeSensitive: boolean) {
  const people = await loadProposalPeople(client, eventId, state, canSeeSensitive);
  const together = await loadTogetherInput(client, eventId, people.flatMap((person) => (person.personId && person.registrationId ? [{ personId: person.personId, registrationId: person.registrationId }] : [])));
  const units: ProposalUnit[] = state.unitRows.map((row) => ({
    ...state.units.get(row.id)!,
    category: row.unit.category, kind: row.unit.kind, isArea: row.unit.isArea,
    groundLevel: row.unit.groundLevel || row.unit.kind !== "ROOM", sortOrder: row.unit.sortOrder,
  }));
  const result = proposeAssignments({ people, units, segments: state.segments, together, eventNights: state.context.nights });
  return { people, placements: result.placements, unplaced: result.unplaced };
}

function placeLabel(state: PlanningState, place: PlanPlacement["place"]) {
  if ("unitId" in place) {
    const meta = state.meta.get(place.unitId);
    return meta ? `${meta.buildingName} ${meta.name}` : "Unknown room";
  }
  return state.buckets.find((bucket) => bucket.id === place.bucketId)?.label ?? "Unknown housing";
}

async function csvPlacements(client: Client, eventId: string, state: PlanningState, csv: string) {
  if (new TextEncoder().encode(csv).byteLength > 200_000) throw new LodgingError("IMPORT_INVALID", "That file is too large.");
  let matrix: string[][];
  try {
    matrix = parseCsvMatrix(csv);
  } catch (error) {
    if (error instanceof CsvImportError) throw new LodgingError("IMPORT_INVALID", error.message);
    throw error;
  }
  if (matrix.length - 1 > MAX_IMPORT_ROWS) throw new LodgingError("IMPORT_INVALID", `Import at most ${MAX_IMPORT_ROWS} rows at a time.`);
  const parsed = parseAssignmentCsv(matrix);
  const problems = parsed.problems.map((problem) => ({ line: problem.line as number | null, message: problem.message }));
  // The place key is "unit:<unit key>" (the property's key), "bucket:<kind>", as the export writes it.
  const unitByKey = new Map<string, string>();
  for (const [unitId, meta] of state.meta) unitByKey.set(meta.key.toLowerCase(), unitId);
  const bucketByKind = new Map(state.buckets.map((bucket) => [bucket.kind.toLowerCase(), bucket.id]));
  const ids = parsed.rows.map((row) => row.occupantId);
  const [attendees, placeholders] = await Promise.all([
    client.registrationAttendee.findMany({ where: { id: { in: ids }, eventId }, select: { id: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } }, registration: { select: { status: true } } } }),
    client.eventLodgingPlaceholder.findMany({ where: { id: { in: ids }, eventId } }),
  ]);
  const attendeeById = new Map(attendees.map((attendee) => [attendee.id, attendee]));
  const placeholderById = new Map(placeholders.map((placeholder) => [placeholder.id, placeholder]));
  const placements: PlanPlacement[] = [];
  const names = new Map<string, string>();
  const lines = new Map<number, number>();
  for (const row of parsed.rows) {
    const attendee = attendeeById.get(row.occupantId);
    const placeholder = placeholderById.get(row.occupantId);
    if (!attendee && !placeholder) { problems.push({ line: row.line, message: "No attendee or expected guest with that id is on this event." }); continue; }
    if (attendee && !(assignableRegistrationStatuses as readonly string[]).includes(attendee.registration.status)) { problems.push({ line: row.line, message: "That registration is not submitted or confirmed." }); continue; }
    if (placeholder && (placeholder.archivedAt || placeholder.linkedAttendeeId)) { problems.push({ line: row.line, message: "That expected guest is archived or linked to a registration." }); continue; }
    const [kind, ...rest] = row.placeKey.split(":");
    const target = rest.join(":").trim().toLowerCase();
    const unitId = kind?.toLowerCase() === "unit" ? unitByKey.get(target) : undefined;
    const bucketId = kind?.toLowerCase() === "bucket" ? bucketByKind.get(target) : undefined;
    if (!unitId && !bucketId) { problems.push({ line: row.line, message: `The place key "${row.placeKey}" does not match a room or housing choice (use unit:<key> or bucket:<kind>).` }); continue; }
    const occupantKey = attendee ? attendee.id : placeholder!.id;
    names.set(occupantKey, attendee ? attendeeName(attendee) : placeholder!.displayName);
    lines.set(placements.length, row.line);
    placements.push({
      occupantKey, occupant: { attendeeId: attendee?.id ?? null, placeholderId: placeholder?.id ?? null }, people: attendee ? 1 : placeholder!.headcount,
      place: unitId ? { unitId } : { bucketId: bucketId! }, firstNight: row.firstNight, lastNight: row.lastNight,
      // An import states where someone should be: it moves them from wherever they were on those nights.
      mode: "MOVE", confirmSpecialUse: false, source: "CSV_IMPORT",
    });
  }
  return { placements, names, lines, problems };
}

/**
 * Preview of a rule-assisted proposal or a CSV import: what would change, row by row, and a fingerprint of exactly that.
 * Reads only; nothing is written, locked or queued. `canSeeSensitive` lets a proposal place accessibility needs on the
 * ground floor; without it the flags are not read at all.
 */
export async function previewAssignmentPlan(eventId: string, rawInput: unknown, options: { canSeeSensitive: boolean }, client: PrismaClient = getPrisma()): Promise<PlanPreview> {
  const input = planRequestSchema.parse(rawInput);
  if (input.mode !== "preview") throw new LodgingError("CONFIRMATION_REQUIRED", "Ask for a preview first.");
  const state = await loadPlanningState(client, eventId);
  const { placements: _placements, ...preview } = await buildPreview(client, eventId, state, input.source, input.csv, options);
  void _placements;
  return preview;
}

async function buildPreview(client: Client, eventId: string, state: PlanningState, source: "PROPOSAL" | "CSV_IMPORT", csv: string | undefined, options: { canSeeSensitive: boolean }): Promise<PlanPreview & { placements: PlanPlacement[] }> {
  let placements: PlanPlacement[];
  let names = new Map<string, string>();
  let lines = new Map<number, number>();
  let problems: PlanPreview["problems"] = [];
  let unplaced: PlanPreview["unplaced"] = [];
  if (source === "PROPOSAL") {
    const proposal = await proposalPlacements(client, eventId, state, options.canSeeSensitive);
    placements = proposal.placements;
    names = new Map(proposal.people.map((person) => [person.occupantKey, person.name]));
    unplaced = proposal.unplaced.map((entry) => ({ occupantId: entry.occupantKey, name: names.get(entry.occupantKey) ?? "Someone", reason: entry.reason }));
  } else {
    if (!csv?.trim()) throw new LodgingError("IMPORT_INVALID", "Paste or choose a CSV file first.");
    const loaded = await csvPlacements(client, eventId, state, csv);
    placements = loaded.placements;
    names = loaded.names;
    lines = loaded.lines;
    problems = loaded.problems;
  }
  const lenient = planPlacementsLenient({ segments: state.segments, units: state.units, buckets: state.bucketIds, eventNights: state.context.nights, placements });
  const problemByIndex = new Map(lenient.problems.map((entry) => [entry.index, entry.problem]));
  const createdKeys = new Set(lenient.plan.creates.map((create) => create.segment.occupantKey));
  const rows: PlanPreviewRow[] = placements.map((placement, index) => {
    const problem = problemByIndex.get(index);
    const moved = lenient.plan.creates.some((create) => create.type === "MOVED_IN" && create.segment.occupantKey === placement.occupantKey && create.segment.firstNight === placement.firstNight);
    return {
      line: lines.get(index) ?? null,
      occupantId: placement.occupantKey,
      name: names.get(placement.occupantKey) ?? "Someone",
      place: placeLabel(state, placement.place),
      firstNight: placement.firstNight,
      lastNight: placement.lastNight,
      outcome: problem ? "PROBLEM" : moved ? "MOVE" : createdKeys.has(placement.occupantKey) ? "NEW" : "UNCHANGED",
      message: problem?.message ?? null,
    };
  });
  const allProblems = [
    ...problems,
    ...lenient.problems.map((entry) => ({ line: lines.get(entry.index) ?? null, message: `${names.get(placements[entry.index]!.occupantKey) ?? "Someone"}: ${entry.problem.message}` })),
  ];
  const counts = {
    new: rows.filter((row) => row.outcome === "NEW").length,
    move: rows.filter((row) => row.outcome === "MOVE").length,
    unchanged: rows.filter((row) => row.outcome === "UNCHANGED").length,
    problems: allProblems.length,
    unplaced: unplaced.length,
  };
  return { source, fingerprint: fingerprintOf(source, placements, rows.map((row) => `${row.outcome}:${row.message ?? ""}`), lenient.plan, state.rowsById), rows, unplaced, problems: allProblems, counts, placements };
}

/**
 * Applies a previewed plan, only if what would happen is exactly what the staff member confirmed. Under the same locks
 * as every assignment writer the plan is rebuilt from scratch and its fingerprint compared; any difference (someone
 * else placed a person, a room was held, the file changed) refuses with PLAN_CHANGED and writes nothing. A CSV with
 * any problem row is refused whole: fix the file and preview again.
 */
export async function applyAssignmentPlan(eventId: string, actorUserId: string, rawInput: unknown, options: { canSeeSensitive: boolean }, client: PrismaClient = getPrisma()): Promise<AssignmentResult> {
  const input = planRequestSchema.parse(rawInput);
  if (input.mode !== "apply") throw new LodgingError("CONFIRMATION_REQUIRED", "Confirm with the fingerprint of the preview.");
  return wrapOverlap(client.$transaction(async (tx) => {
    const state = await lockedState(tx, eventId);
    const preview = await buildPreview(tx, eventId, state, input.source, input.csv, options);
    if (preview.fingerprint !== input.fingerprint) {
      throw new LodgingError("PLAN_CHANGED", "Something changed since you previewed this. Nothing was applied. Preview it again.");
    }
    if (input.source === "CSV_IMPORT" && preview.problems.length > 0) {
      throw new LodgingError("IMPORT_HAS_PROBLEMS", "Some rows have problems. Nothing was applied. Fix the file and preview again.");
    }
    const result = planPlacements({ segments: state.segments, units: state.units, buckets: state.bucketIds, eventNights: state.context.nights, placements: preview.placements.filter((_, index) => preview.rows[index]!.outcome !== "PROBLEM") });
    if (!result.ok) throw problemError(result.problem);
    const reason = input.reason || sourceReason[input.source];
    return finishPlan(tx, { eventId, actorUserId, reason, source: input.source, state }, result.plan, input.source === "PROPOSAL" ? "Applied a rule-assisted lodging proposal." : "Applied a confirmed lodging CSV import.", input.source === "PROPOSAL" ? "LODGING_PROPOSAL_APPLIED" : "LODGING_IMPORT_APPLIED", { fingerprint: input.fingerprint });
  }, { timeout: lodgingTransactionTimeoutMs }));
}
