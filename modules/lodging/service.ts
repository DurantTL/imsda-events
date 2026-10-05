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

/**
 * An event picks a property (idempotent: picking the same one again adds any
 * units a newer template introduced). Each unit gets its per-event row, with
 * the template's unavailable default; a unit's default hold (cooks, the nurse)
 * is placed for the event's whole window, once, by the row's creation.
 */
export async function selectEventProperty(eventId: string, actorUserId: string, rawInput: unknown, client: PrismaClient = getPrisma()) {
  const input = selectPropertySchema.parse(rawInput);
  return client.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw new LodgingError("EVENT_NOT_FOUND", "That event was not found.");
    const property = await tx.lodgingProperty.findUnique({ where: { key: input.propertyKey } });
    if (!property) throw new LodgingError("PROPERTY_UNKNOWN", "That lodging property is not set up. Run npm run lodging:sync.");
    // Serialize concurrent picks for one event on the (unique) event row's lodging insert.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lodging-select:${eventId}`}))`;
    let eventLodging = await tx.eventLodging.findUnique({ where: { eventId }, include: { event: { select: { startsAt: true, endsAt: true, timezone: true } } } });
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
        include: { event: { select: { startsAt: true, endsAt: true, timezone: true } } },
      });
      created = true;
    } else if (eventLodging.templateVersion !== property.templateVersion) {
      eventLodging = await tx.eventLodging.update({
        where: { id: eventLodging.id },
        data: { templateVersion: property.templateVersion },
        include: { event: { select: { startsAt: true, endsAt: true, timezone: true } } },
      });
    }
    const nights = nightsFor(eventLodging);
    const existing = new Set((await tx.eventLodgingUnit.findMany({ where: { eventLodgingId: eventLodging.id }, select: { unitId: true } })).map((row) => row.unitId));
    const units = await tx.lodgingUnit.findMany({ where: { propertyId: property.id, retiredAt: null, id: { notIn: [...existing] } }, orderBy: { sortOrder: "asc" } });
    let holdsPlaced = 0;
    for (const unit of units) {
      const row = await tx.eventLodgingUnit.create({
        data: {
          eventId,
          eventLodgingId: eventLodging.id,
          unitId: unit.id,
          unavailable: unit.defaultUnavailable,
          unavailableReason: unit.defaultUnavailable ? "Unavailable by default" : null,
          updatedByUserId: actorUserId,
        },
      });
      if (unit.defaultHoldKind && unit.defaultHoldReason && nights.length > 0) {
        await insertHold(tx, eventId, row.id, { kind: unit.defaultHoldKind, reason: unit.defaultHoldReason, firstNight: nights[0]!, lastNight: nights[nights.length - 1]! }, actorUserId);
        holdsPlaced += 1;
      }
    }
    if (created || units.length > 0) {
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "LODGING_PROPERTY_SELECTED",
        entityType: "EventLodging",
        entityId: eventLodging.id,
        summary: `${created ? "Chose" : "Updated"} lodging property ${property.name} (${units.length} unit(s) added).`,
        metadata: { propertyKey: property.key, templateVersion: property.templateVersion, unitsAdded: units.length, holdsPlaced },
      }, tx);
    }
    return { eventLodgingId: eventLodging.id, created, unitsAdded: units.length, holdsPlaced };
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
) {
  try {
    const row = await tx.eventLodgingHold.create({
      data: { eventId, eventLodgingUnitId: eventUnitId, kind: hold.kind, reason: hold.reason, firstNight: toDate(hold.firstNight), lastNight: toDate(hold.lastNight), createdByUserId: actorUserId },
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
    if (input.rate) {
      await tx.eventLodgingRate.upsert({
        where: { eventLodgingId_category: { eventLodgingId: lodging.id, category: input.category } },
        create: { eventId, eventLodgingId: lodging.id, category: input.category, ...input.rate, updatedByUserId: actorUserId },
        update: { ...input.rate, updatedByUserId: actorUserId },
      });
    } else if (before) {
      await tx.eventLodgingRate.delete({ where: { id: before.id } });
    }
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_RATE_CHANGED", entityType: "EventLodgingRate", entityId: before?.id ?? lodging.id,
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
          unit: { include: { beds: { orderBy: { position: "asc" } }, building: true } },
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
    assignable: row.unit.assignable,
    retired: row.unit.retiredAt !== null,
    defaultCapacity: row.unit.defaultCapacity,
    capacityOverride: row.capacityOverride,
    unavailable: row.unavailable,
    activeFrom: row.unit.activeFrom ? toNight(row.unit.activeFrom) : null,
    activeUntil: row.unit.activeUntil ? toNight(row.unit.activeUntil) : null,
    holds: row.holds.filter((hold) => !hold.releasedAt).map((hold) => ({ id: hold.id, firstNight: toNight(hold.firstNight), lastNight: toNight(hold.lastNight) })),
  }));
  const projection = projectAvailability({ nights, units: states });
  const buildings = new Map<string, { sortOrder: number; key: string; name: string; units: Array<{ sort: number; view: LodgingUnitView }> }>();
  for (const row of lodging.units) {
    if (row.unit.retiredAt) continue;
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
      assignable: row.unit.assignable,
      notes: row.unit.notes,
      beds: bedSummary(row.unit.beds.map((bed) => bed.type)),
      defaultCapacity: row.unit.defaultCapacity,
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
