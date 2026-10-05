import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  calendarDay,
  eventNights,
  holdChangeSchema,
  holdCreateSchema,
  projectAvailability,
  rateSchema,
  selectPropertySchema,
  unitUpdateSchema,
  type LodgingBathroom,
  type LodgingCategory,
  type LodgingHoldKind,
  type LodgingRate,
  type LodgingRateBasis,
  type LodgingUnitKind,
  type NightStatus,
  type UnitNightState,
} from "@/modules/lodging/domain";
import { LodgingError } from "@/modules/lodging/errors";

type Tx = Prisma.TransactionClient;

const toDate = (night: string) => new Date(`${night}T00:00:00Z`);
const toNight = (date: Date) => date.toISOString().slice(0, 10);

/** Transaction timeout that leaves room for a row-lock wait plus the work after it. */
export const lodgingTransactionTimeoutMs = 20_000;

/**
 * Locks the event's unit rows (in id order, so two callers never deadlock) for
 * the rest of the transaction. Everything that changes what a unit can hold
 * takes this lock first; the assignment work in #200 must do the same before it
 * counts occupancy and allocates, so one exclusive unit cannot be allocated twice.
 */
export async function lockEventLodgingUnits(tx: Tx, eventId: string, eventUnitIds: readonly string[]) {
  if (eventUnitIds.length === 0) return;
  const ids = [...new Set(eventUnitIds)].sort();
  await tx.$queryRaw`SELECT "id" FROM "EventLodgingUnit" WHERE "eventId" = ${eventId} AND "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
}

/**
 * Marks that something the event's lodging can hold, or has promised, just changed. Every capacity writer (holds,
 * closures, capacity overrides, layout updates, property choice, lodging requests and registration submissions) calls
 * this inside its transaction, **after taking the unit locks**. The update takes the `EventLodging` row lock and, in a
 * Serializable transaction that read capacity before another writer committed, fails with a serialization error
 * instead of writing: the stale reader is retried and counts again. A Read Committed writer simply waits and reads
 * fresh data.
 */
export async function touchEventLodgingCapacity(tx: Tx, eventLodgingId: string) {
  await tx.$executeRaw`UPDATE "EventLodging" SET "capacityVersion" = "capacityVersion" + 1 WHERE "id" = ${eventLodgingId}`;
}

function isOverlapViolation(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("EventLodgingHold_no_overlap") || message.includes("23P01");
}

async function eventLodgingFor(tx: Tx, eventId: string) {
  const row = await tx.eventLodging.findUnique({ where: { eventId }, include: { event: { select: { startsAt: true, endsAt: true, timezone: true } } } });
  if (!row) throw new LodgingError("NO_PROPERTY", "Choose a lodging property for this event first.");
  return row;
}

export function nightsFor(row: { firstNight: Date | null; lastNight: Date | null; event: { startsAt: Date; endsAt: Date; timezone: string } }) {
  return eventNights({
    startDate: calendarDay(row.event.startsAt, row.event.timezone),
    endDate: calendarDay(row.event.endsAt, row.event.timezone),
    firstNight: row.firstNight ? toNight(row.firstNight) : null,
    lastNight: row.lastNight ? toNight(row.lastNight) : null,
  });
}

function assertWithin(nights: readonly string[], firstNight: string, lastNight: string) {
  if (nights.length === 0) throw new LodgingError("NO_NIGHTS", "This event has no bookable nights.");
  if (firstNight < nights[0]! || lastNight > nights[nights.length - 1]!) {
    throw new LodgingError("WINDOW_OUTSIDE_EVENT", `Choose nights between ${nights[0]} and ${nights[nights.length - 1]}.`);
  }
}

// ---------------------------------------------------------------------------
// Choosing a property
// ---------------------------------------------------------------------------

type SnapshotSource = { defaultCapacity: number | null; assignable: boolean; retiredAt: Date | null; beds: Array<{ type: string }> };

function snapshotOf(unit: SnapshotSource) {
  return {
    defaultCapacity: unit.defaultCapacity,
    bedsSummary: bedSummary(unit.beds.map((bed) => bed.type)),
    assignable: unit.assignable,
    retired: unit.retiredAt !== null,
  };
}

/**
 * Moves the system-placed default holds (cooks, nurse; never a staff-placed
 * hold) to cover the event's current nights, with a history row for each. A
 * default hold that would collide with another active hold is left alone; the
 * screen then warns that it no longer covers the event.
 */
async function followEventNights(tx: Tx, eventId: string, nights: readonly string[], actorUserId: string) {
  if (nights.length === 0) return 0;
  const first = nights[0]!;
  const last = nights[nights.length - 1]!;
  const defaults = await tx.eventLodgingHold.findMany({ where: { eventId, systemDefault: true, releasedAt: null } });
  let moved = 0;
  for (const hold of defaults) {
    if (toNight(hold.firstNight) === first && toNight(hold.lastNight) === last) continue;
    await lockEventLodgingUnits(tx, eventId, [hold.eventLodgingUnitId]);
    const clash = await tx.eventLodgingHold.count({
      where: { eventLodgingUnitId: hold.eventLodgingUnitId, releasedAt: null, id: { not: hold.id }, firstNight: { lte: toDate(last) }, lastNight: { gte: toDate(first) } },
    });
    if (clash > 0) continue;
    await tx.eventLodgingHold.update({ where: { id: hold.id }, data: { firstNight: toDate(first), lastNight: toDate(last) } });
    await tx.eventLodgingHoldHistory.create({ data: { eventId, holdId: hold.id, type: "WINDOW_CHANGED", actorUserId, firstNight: toDate(first), lastNight: toDate(last) } });
    moved += 1;
  }
  return moved;
}

/**
 * An event picks a property (idempotent). Each unit gets its per-event row
 * with a snapshot of the layout (capacity, beds), so later template versions
 * never change a live event's capacity; they reach it only through
 * `updateEventLayout`. The template's unavailable default is copied, and a
 * unit's default hold (cooks, nurse) is placed for the event's nights as a
 * system-placed hold. Choosing the same property again applies a given night
 * window (or leaves it) and moves the default holds to cover the event's
 * current nights.
 */
export async function selectEventProperty(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = selectPropertySchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw new LodgingError("EVENT_NOT_FOUND", "That event was not found.");
    const property = await tx.lodgingProperty.findUnique({ where: { key: input.propertyKey } });
    if (!property) throw new LodgingError("PROPERTY_UNKNOWN", "That lodging property is not set up. Run npm run lodging:sync.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-select:${eventId}`}))`;
    const eventInclude = { event: { select: { startsAt: true, endsAt: true, timezone: true } } } as const;
    let eventLodging = await tx.eventLodging.findUnique({ where: { eventId }, include: eventInclude });
    let created = false;
    if (eventLodging && eventLodging.propertyId !== property.id) {
      throw new LodgingError("PROPERTY_ALREADY_SET", "This event already uses a different lodging property.");
    }
    if (!eventLodging) {
      eventLodging = await tx.eventLodging.create({
        data: {
          eventId,
          propertyId: property.id,
          templateVersion: property.templateVersion,
          firstNight: input.firstNight ? toDate(input.firstNight) : null,
          lastNight: input.lastNight ? toDate(input.lastNight) : null,
          createdByUserId: actorUserId,
        },
        include: eventInclude,
      });
      created = true;
    } else if (input.firstNight !== undefined || input.lastNight !== undefined) {
      // A window given on a re-pick is applied, never ignored.
      eventLodging = await tx.eventLodging.update({
        where: { id: eventLodging.id },
        data: {
          ...(input.firstNight !== undefined ? { firstNight: input.firstNight ? toDate(input.firstNight) : null } : {}),
          ...(input.lastNight !== undefined ? { lastNight: input.lastNight ? toDate(input.lastNight) : null } : {}),
        },
        include: eventInclude,
      });
    }
    const nights = nightsFor(eventLodging);
    let unitsAdded = 0;
    let holdsPlaced = 0;
    if (created) {
      const units = await tx.lodgingUnit.findMany({ where: { propertyId: property.id, retiredAt: null }, include: { beds: { orderBy: { position: "asc" } } }, orderBy: { sortOrder: "asc" } });
      for (const unit of units) {
        const row = await tx.eventLodgingUnit.create({
          data: {
            eventId,
            eventLodgingId: eventLodging.id,
            unitId: unit.id,
            ...snapshotOf(unit),
            unavailable: unit.defaultUnavailable,
            unavailableReason: unit.defaultUnavailable ? "Unavailable by default" : null,
            updatedByUserId: actorUserId,
          },
        });
        unitsAdded += 1;
        if (unit.defaultHoldKind && unit.defaultHoldReason && nights.length > 0) {
          await insertHold(tx, eventId, row.id, { kind: unit.defaultHoldKind, reason: unit.defaultHoldReason, firstNight: nights[0]!, lastNight: nights[nights.length - 1]! }, actorUserId, true);
          holdsPlaced += 1;
        }
      }
    }
    const holdsMoved = created ? 0 : await followEventNights(tx, eventId, nights, actorUserId);
    if (created || holdsMoved > 0) await touchEventLodgingCapacity(tx, eventLodging.id);
    if (created || holdsMoved > 0 || input.firstNight !== undefined || input.lastNight !== undefined) {
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "LODGING_PROPERTY_SELECTED",
        entityType: "EventLodging",
        entityId: eventLodging.id,
        summary: `${created ? "Chose" : "Re-checked"} lodging property ${property.name} (${unitsAdded} unit(s) added, ${holdsMoved} default hold(s) moved).`,
        metadata: { propertyKey: property.key, templateVersion: eventLodging.templateVersion, unitsAdded, holdsPlaced, holdsMoved },
      }, tx);
    }
    return { eventLodgingId: eventLodging.id, created, unitsAdded, holdsPlaced, holdsMoved };
  }, { timeout: lodgingTransactionTimeoutMs });
}

/**
 * "Update to latest property layout": the only way a newer template version
 * reaches an event. Refreshes every unit's capacity, beds, assignable and
 * retired snapshot from the property's current layout and adds units the
 * template introduced (with their default unavailable state and holds).
 * Per-event overrides, unavailable flags and holds are kept. Audited.
 */
export async function updateEventLayout(eventId: string, actorUserId: string, client: PrismaClient = getPrisma()) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-select:${eventId}`}))`;
    const lodging = await eventLodgingFor(tx, eventId);
    const property = await tx.lodgingProperty.findUniqueOrThrow({ where: { id: lodging.propertyId } });
    const rows = await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: lodging.id } });
    await lockEventLodgingUnits(tx, eventId, rows.map((row) => row.id));
    await touchEventLodgingCapacity(tx, lodging.id);
    const units = await tx.lodgingUnit.findMany({ where: { propertyId: property.id }, include: { beds: { orderBy: { position: "asc" } } }, orderBy: { sortOrder: "asc" } });
    const nights = nightsFor(lodging);
    const byUnit = new Map(rows.map((row) => [row.unitId, row]));
    let updated = 0;
    let added = 0;
    for (const unit of units) {
      const snapshot = snapshotOf(unit);
      const row = byUnit.get(unit.id);
      if (row) {
        if (row.defaultCapacity !== snapshot.defaultCapacity || row.bedsSummary !== snapshot.bedsSummary || row.assignable !== snapshot.assignable || row.retired !== snapshot.retired) {
          await tx.eventLodgingUnit.update({ where: { id: row.id }, data: snapshot });
          updated += 1;
        }
      } else if (!unit.retiredAt) {
        const created = await tx.eventLodgingUnit.create({
          data: { eventId, eventLodgingId: lodging.id, unitId: unit.id, ...snapshot, unavailable: unit.defaultUnavailable, unavailableReason: unit.defaultUnavailable ? "Unavailable by default" : null, updatedByUserId: actorUserId },
        });
        added += 1;
        if (unit.defaultHoldKind && unit.defaultHoldReason && nights.length > 0) {
          await insertHold(tx, eventId, created.id, { kind: unit.defaultHoldKind, reason: unit.defaultHoldReason, firstNight: nights[0]!, lastNight: nights[nights.length - 1]! }, actorUserId, true);
        }
      }
    }
    const from = lodging.templateVersion;
    await tx.eventLodging.update({ where: { id: lodging.id }, data: { templateVersion: property.templateVersion } });
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_LAYOUT_UPDATED", entityType: "EventLodging", entityId: lodging.id,
      summary: `Updated the ${property.name} layout from version ${from} to ${property.templateVersion} (${updated} changed, ${added} added).`,
      metadata: { propertyKey: property.key, fromVersion: from, toVersion: property.templateVersion, unitsChanged: updated, unitsAdded: added },
    }, tx);
    return { fromVersion: from, toVersion: property.templateVersion, unitsChanged: updated, unitsAdded: added };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Per-event unit state
// ---------------------------------------------------------------------------

export async function updateEventUnit(eventId: string, eventUnitId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = unitUpdateSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    await lockEventLodgingUnits(tx, eventId, [eventUnitId]);
    const before = await tx.eventLodgingUnit.findFirst({ where: { id: eventUnitId, eventId }, include: { unit: true } });
    if (!before) throw new LodgingError("UNIT_NOT_FOUND", "That lodging unit was not found for this event.");
    await touchEventLodgingCapacity(tx, before.eventLodgingId);
    const unavailable = input.unavailable ?? before.unavailable;
    const updated = await tx.eventLodgingUnit.update({
      where: { id: eventUnitId },
      data: {
        ...(input.capacityOverride !== undefined ? { capacityOverride: input.capacityOverride } : {}),
        unavailable,
        // The note only belongs to an unavailable unit.
        unavailableReason: unavailable ? (input.unavailableReason !== undefined ? (input.unavailableReason || null) : before.unavailableReason) : null,
        updatedByUserId: actorUserId,
      },
    });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "LODGING_UNIT_UPDATED",
      entityType: "EventLodgingUnit",
      entityId: eventUnitId,
      summary: `Changed lodging unit ${before.unit.name}.`,
      metadata: {
        unitKey: before.unit.key,
        capacityOverride: { from: before.capacityOverride, to: updated.capacityOverride },
        unavailable: { from: before.unavailable, to: updated.unavailable },
      },
    }, tx);
    return { id: updated.id, capacityOverride: updated.capacityOverride, unavailable: updated.unavailable, unavailableReason: updated.unavailableReason };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Holds: reason, actor, window and history. Released, never deleted.
// ---------------------------------------------------------------------------

async function insertHold(
  tx: Tx,
  eventId: string,
  eventUnitId: string,
  hold: { kind: LodgingHoldKind; reason: string; firstNight: string; lastNight: string },
  actorUserId: string | null,
  systemDefault = false,
) {
  try {
    const row = await tx.eventLodgingHold.create({
      data: { eventId, eventLodgingUnitId: eventUnitId, kind: hold.kind, reason: hold.reason, firstNight: toDate(hold.firstNight), lastNight: toDate(hold.lastNight), systemDefault, createdByUserId: actorUserId },
    });
    await tx.eventLodgingHoldHistory.create({
      data: { eventId, holdId: row.id, type: "CREATED", actorUserId, kind: hold.kind, reason: hold.reason, firstNight: toDate(hold.firstNight), lastNight: toDate(hold.lastNight) },
    });
    return row;
  } catch (error) {
    if (isOverlapViolation(error)) throw new LodgingError("HOLD_OVERLAP", "That unit already has an active hold on some of those nights. Release or change it first.");
    throw error;
  }
}

export async function createHold(eventId: string, eventUnitId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = holdCreateSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const lodging = await eventLodgingFor(tx, eventId);
    assertWithin(nightsFor(lodging), input.firstNight, input.lastNight);
    await lockEventLodgingUnits(tx, eventId, [eventUnitId]);
    const unit = await tx.eventLodgingUnit.findFirst({ where: { id: eventUnitId, eventId }, include: { unit: { select: { key: true, name: true } } } });
    if (!unit) throw new LodgingError("UNIT_NOT_FOUND", "That lodging unit was not found for this event.");
    await touchEventLodgingCapacity(tx, lodging.id);
    const hold = await insertHold(tx, eventId, eventUnitId, input, actorUserId);
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_HOLD_CREATED", entityType: "EventLodgingHold", entityId: hold.id,
      summary: `Placed a ${input.kind.toLowerCase()} hold on ${unit.unit.name}.`,
      metadata: { unitKey: unit.unit.key, kind: input.kind, firstNight: input.firstNight, lastNight: input.lastNight },
    }, tx);
    return { id: hold.id };
  }, { timeout: lodgingTransactionTimeoutMs });
}

export async function changeHold(eventId: string, holdId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = holdChangeSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const found = await tx.eventLodgingHold.findFirst({ where: { id: holdId, eventId }, include: { eventUnit: { include: { unit: { select: { key: true, name: true } } } } } });
    if (!found) throw new LodgingError("HOLD_NOT_FOUND", "That hold was not found for this event.");
    await lockEventLodgingUnits(tx, eventId, [found.eventLodgingUnitId]);
    const hold = await tx.eventLodgingHold.findUniqueOrThrow({ where: { id: holdId } });
    if (hold.releasedAt) throw new LodgingError("HOLD_RELEASED", "That hold was already released.");
    await touchEventLodgingCapacity(tx, found.eventUnit.eventLodgingId);
    if (input.action === "release") {
      const now = new Date();
      await tx.eventLodgingHold.update({ where: { id: holdId }, data: { releasedAt: now, releasedByUserId: actorUserId, releaseReason: input.reason } });
      await tx.eventLodgingHoldHistory.create({ data: { eventId, holdId, type: "RELEASED", actorUserId, at: now, reason: input.reason } });
      await writeAuditLog({
        eventId, actorUserId, action: "LODGING_HOLD_RELEASED", entityType: "EventLodgingHold", entityId: holdId,
        summary: `Released the hold on ${found.eventUnit.unit.name}.`, metadata: { unitKey: found.eventUnit.unit.key },
      }, tx);
      return { id: holdId, released: true };
    }
    const lodging = await eventLodgingFor(tx, eventId);
    assertWithin(nightsFor(lodging), input.firstNight, input.lastNight);
    try {
      await tx.eventLodgingHold.update({ where: { id: holdId }, data: { firstNight: toDate(input.firstNight), lastNight: toDate(input.lastNight) } });
    } catch (error) {
      if (isOverlapViolation(error)) throw new LodgingError("HOLD_OVERLAP", "That unit already has another active hold on some of those nights.");
      throw error;
    }
    await tx.eventLodgingHoldHistory.create({
      data: { eventId, holdId, type: "WINDOW_CHANGED", actorUserId, firstNight: toDate(input.firstNight), lastNight: toDate(input.lastNight) },
    });
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_HOLD_CHANGED", entityType: "EventLodgingHold", entityId: holdId,
      summary: `Changed the hold window on ${found.eventUnit.unit.name}.`,
      metadata: { unitKey: found.eventUnit.unit.key, from: { firstNight: toNight(hold.firstNight), lastNight: toNight(hold.lastNight) }, to: { firstNight: input.firstNight, lastNight: input.lastNight } },
    }, tx);
    return { id: holdId, released: false };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// Optional rates (finance permission is checked by the caller). Never seeded.
// ---------------------------------------------------------------------------

export async function setEventRate(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = rateSchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const lodging = await eventLodgingFor(tx, eventId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-rate:${lodging.id}`}))`;
    const before = await tx.eventLodgingRate.findUnique({ where: { eventLodgingId_category: { eventLodgingId: lodging.id, category: input.category } } });
    const snapshot = (rate: { amountCents: number; basis: LodgingRateBasis; minimumNights: number | null } | null) =>
      rate ? { amountCents: rate.amountCents, basis: rate.basis, minimumNights: rate.minimumNights } : null;
    let rateId = before?.id;
    if (input.rate) {
      const saved = await tx.eventLodgingRate.upsert({
        where: { eventLodgingId_category: { eventLodgingId: lodging.id, category: input.category } },
        create: { eventId, eventLodgingId: lodging.id, category: input.category, ...input.rate, updatedByUserId: actorUserId },
        update: { ...input.rate, updatedByUserId: actorUserId },
      });
      rateId = saved.id;
    } else if (before) {
      await tx.eventLodgingRate.delete({ where: { id: before.id } });
    } else {
      // Removing a rate that does not exist changes nothing and leaves no audit row.
      return { category: input.category, rate: null };
    }
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_RATE_CHANGED", entityType: "EventLodgingRate", entityId: rateId!,
      summary: `Changed the ${input.category.toLowerCase().replaceAll("_", " ")} lodging rate.`,
      metadata: { category: input.category, from: snapshot(before), to: snapshot(input.rate) },
    }, tx);
    return { category: input.category, rate: input.rate };
  }, { timeout: lodgingTransactionTimeoutMs });
}

// ---------------------------------------------------------------------------
// The staff view: inventory, state and night-by-night availability
// ---------------------------------------------------------------------------

export type LodgingHoldView = {
  id: string;
  kind: LodgingHoldKind;
  reason: string;
  firstNight: string;
  lastNight: string;
  createdAt: string;
  active: boolean;
  /** Placed by the property template (cooks, nurse), not by staff. */
  systemDefault: boolean;
  /** A default hold that no longer covers every night of the event: extend it to cover the event. */
  staleDefault: boolean;
  releaseReason: string | null;
  history: Array<{ type: string; at: string; reason: string | null; firstNight: string | null; lastNight: string | null; actorUserId: string | null }>;
};

export type LodgingUnitView = {
  eventUnitId: string;
  key: string;
  name: string;
  kind: LodgingUnitKind;
  isArea: boolean;
  category: LodgingCategory | null;
  floor: number | null;
  groundLevel: boolean;
  bathroom: LodgingBathroom;
  linensProvided: boolean | null;
  specialUse: boolean;
  assignable: boolean;
  /** Dropped by a template version this event has adopted; shown only while a hold is still active. */
  retired: boolean;
  notes: string | null;
  beds: string;
  defaultCapacity: number | null;
  capacityOverride: number | null;
  unavailable: boolean;
  unavailableReason: string | null;
  /** One status per night, aligned with `LodgingView.nights`. */
  nightStatuses: NightStatus[];
  /** People the unit takes per night; null is no fixed limit. */
  nightCapacities: Array<number | null>;
  holds: LodgingHoldView[];
};

export type LodgingView = {
  eventId: string;
  property: { key: string; name: string; templateVersion: number; currentTemplateVersion: number } | null;
  nights: string[];
  buildings: Array<{ key: string; name: string; units: LodgingUnitView[] }>;
  /** Rates by category; absent means included or free. */
  rates: Partial<Record<LodgingCategory, LodgingRate>>;
  /** Total people the inventory takes per night, by category ("OTHER" has none). */
  totalsByNight: Array<{ night: string; capacity: number; unlimited: boolean }>;
  availableProperties: Array<{ key: string; name: string }>;
};

export async function getLodgingView(eventId: string, client: PrismaClient = getPrisma()): Promise<LodgingView> {
  const availableProperties = (await client.lodgingProperty.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }));
  const lodging = await client.eventLodging.findUnique({
    where: { eventId },
    include: {
      event: { select: { startsAt: true, endsAt: true, timezone: true } },
      property: { select: { key: true, name: true, templateVersion: true } },
      rates: true,
      units: {
        include: {
          unit: { include: { building: true } },
          holds: { include: { history: { orderBy: { at: "asc" } } }, orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!lodging) {
    return { eventId, property: null, nights: [], buildings: [], rates: {}, totalsByNight: [], availableProperties };
  }
  const nights = nightsFor(lodging);
  const states: UnitNightState[] = lodging.units.map((row) => ({
    unitId: row.id,
    assignable: row.assignable,
    retired: row.retired,
    defaultCapacity: row.defaultCapacity,
    capacityOverride: row.capacityOverride,
    unavailable: row.unavailable,
    activeFrom: row.unit.activeFrom ? toNight(row.unit.activeFrom) : null,
    activeUntil: row.unit.activeUntil ? toNight(row.unit.activeUntil) : null,
    holds: row.holds.filter((hold) => !hold.releasedAt).map((hold) => ({ id: hold.id, firstNight: toNight(hold.firstNight), lastNight: toNight(hold.lastNight) })),
  }));
  const projection = projectAvailability({ nights, units: states });
  const buildings = new Map<string, { sortOrder: number; key: string; name: string; units: Array<{ sort: number; view: LodgingUnitView }> }>();
  for (const row of lodging.units) {
    // A retired unit stays visible only while it still has an active hold.
    if (row.retired && !row.holds.some((hold) => hold.releasedAt === null)) continue;
    const rows = projection.get(row.id) ?? [];
    const view: LodgingUnitView = {
      eventUnitId: row.id,
      key: row.unit.key,
      name: row.unit.name,
      kind: row.unit.kind,
      isArea: row.unit.isArea,
      category: row.unit.category,
      floor: row.unit.floor,
      groundLevel: row.unit.groundLevel,
      bathroom: row.unit.bathroom,
      linensProvided: row.unit.linensProvided,
      specialUse: row.unit.specialUse,
      assignable: row.assignable,
      retired: row.retired,
      notes: row.unit.notes,
      beds: row.bedsSummary,
      defaultCapacity: row.defaultCapacity,
      capacityOverride: row.capacityOverride,
      unavailable: row.unavailable,
      unavailableReason: row.unavailableReason,
      nightStatuses: rows.map((night) => night.status),
      nightCapacities: rows.map((night) => night.capacity),
      holds: row.holds.map((hold) => ({
        id: hold.id,
        kind: hold.kind,
        reason: hold.reason,
        firstNight: toNight(hold.firstNight),
        lastNight: toNight(hold.lastNight),
        createdAt: hold.createdAt.toISOString(),
        active: hold.releasedAt === null,
        systemDefault: hold.systemDefault,
        staleDefault: hold.systemDefault && hold.releasedAt === null && nights.length > 0
          && (toNight(hold.firstNight) > nights[0]! || toNight(hold.lastNight) < nights[nights.length - 1]!),
        releaseReason: hold.releaseReason,
        history: hold.history.map((entry) => ({
          type: entry.type,
          at: entry.at.toISOString(),
          reason: entry.reason,
          firstNight: entry.firstNight ? toNight(entry.firstNight) : null,
          lastNight: entry.lastNight ? toNight(entry.lastNight) : null,
          actorUserId: entry.actorUserId,
        })),
      })),
    };
    const building = buildings.get(row.unit.buildingId) ?? { sortOrder: row.unit.building.sortOrder, key: row.unit.building.key, name: row.unit.building.name, units: [] };
    building.units.push({ sort: row.unit.sortOrder, view });
    buildings.set(row.unit.buildingId, building);
  }
  const totalsByNight = nights.map((night, index) => {
    let capacity = 0;
    let unlimited = false;
    for (const rows of projection.values()) {
      const row = rows[index]!;
      if (row.status !== "AVAILABLE") continue;
      if (row.capacity === null) unlimited = true; else capacity += row.capacity;
    }
    return { night, capacity, unlimited };
  });
  const rates: LodgingView["rates"] = {};
  for (const rate of lodging.rates) rates[rate.category] = { amountCents: rate.amountCents, basis: rate.basis, minimumNights: rate.minimumNights };
  const currentTemplateVersion = (await client.lodgingProperty.findUnique({ where: { id: lodging.propertyId }, select: { templateVersion: true } }))?.templateVersion ?? lodging.templateVersion;
  return {
    eventId,
    property: { key: lodging.property.key, name: lodging.property.name, templateVersion: lodging.templateVersion, currentTemplateVersion },
    nights,
    buildings: [...buildings.values()].sort((a, b) => a.sortOrder - b.sortOrder).map((building) => ({
      key: building.key,
      name: building.name,
      units: building.units.sort((a, b) => a.sort - b.sort).map((entry) => entry.view),
    })),
    rates,
    totalsByNight,
    availableProperties,
  };
}

const bedLabels: Record<string, string> = { QUEEN: "queen", DOUBLE: "double", TWIN: "twin", TWIN_BUNK: "twin bunk" };

function bedSummary(types: readonly string[]) {
  const counts = new Map<string, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${count} ${bedLabels[type] ?? type}`).join(", ");
}
