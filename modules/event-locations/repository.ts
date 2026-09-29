import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import {
  countLocationSeats,
  lockEventLocation,
} from "@/modules/event-locations/admission";
import {
  eventLocationInputSchema,
  eventLocationOrderSchema,
  eventLocationUpdateSchema,
  maximumLocationsPerEvent,
  normalizeLocationName,
  remainingLocationSeats,
  locationDateProblem,
} from "@/modules/event-locations/domain";
import { EventLocationError, locationBusyMessage, locationTransactionTimeoutMs } from "@/modules/event-locations/errors";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";

type Db = Prisma.TransactionClient;

const locationOrder = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }, { name: "asc" as const }];

function serialize(
  location: Prisma.EventLocationGetPayload<object>,
  usage: { occupied: number; registrations: number },
) {
  return {
    id: location.id,
    name: location.name,
    address: location.address,
    firstDay: location.firstDay,
    lastDay: location.lastDay,
    capacity: location.capacity,
    registrationClosesOn: location.registrationClosesOn,
    sortOrder: location.sortOrder,
    isActive: location.isActive,
    /** People at this location, counted like the event capacity. */
    occupied: usage.occupied,
    remaining: remainingLocationSeats(location.capacity, usage.occupied),
    /** Registrations of any status that name this location: deletion is refused while there are any. */
    registrations: usage.registrations,
    updatedAt: location.updatedAt.toISOString(),
  };
}

export type EventLocationRecord = ReturnType<typeof serialize>;

/** Seats taken and registrations naming each location of `eventId`. */
async function usageByLocation(db: Db | ReturnType<typeof getPrisma>, eventId: string) {
  const rows = await db.registration.findMany({
    where: { eventId, locationId: { not: null } },
    select: { locationId: true, status: true, _count: { select: { attendees: true } } },
  });
  const usage = new Map<string, { occupied: number; registrations: number }>();
  for (const row of rows) {
    if (!row.locationId) continue;
    const entry = usage.get(row.locationId) ?? { occupied: 0, registrations: 0 };
    entry.registrations += 1;
    if ((activeRegistrationStatuses as readonly string[]).includes(row.status)) entry.occupied += row._count.attendees;
    usage.set(row.locationId, entry);
  }
  return usage;
}

/** Every location of the event, in the saved order, with its seat usage. */
export async function listEventLocations(eventId: string, db: Db | ReturnType<typeof getPrisma> = getPrisma()) {
  const [locations, usage] = await Promise.all([
    db.eventLocation.findMany({ where: { eventId }, orderBy: locationOrder }),
    usageByLocation(db, eventId),
  ]);
  return locations.map((location) => serialize(location, usage.get(location.id) ?? { occupied: 0, registrations: 0 }));
}

/** Locking the event row keeps a create from racing another create over the limit and order. */
async function lockEventForLocations(tx: Db, eventId: string) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  let rows: { id: string }[];
  try {
    // NO KEY UPDATE, like an event settings save: registrations, which take a
    // key-share lock on the event, are never stalled by a location edit.
    rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR NO KEY UPDATE`;
  } catch (error) {
    if (isLockTimeoutError(error)) throw new EventLocationError("LOCATION_BUSY", locationBusyMessage);
    throw error;
  }
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  if (rows.length === 0) throw new EventLocationError("EVENT_NOT_FOUND", "That event no longer exists.");
}

function nameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new EventLocationError("LOCATION_NAME_TAKEN", "Another location in this event already has that name.");
  }
  throw error;
}

export async function createEventLocation(eventId: string, actorUserId: string, rawInput: unknown) {
  const input = eventLocationInputSchema.parse(rawInput);
  try {
    const created = await getPrisma().$transaction(async (tx) => {
      await lockEventForLocations(tx, eventId);
      const existing = await tx.eventLocation.findMany({ where: { eventId }, select: { sortOrder: true } });
      if (existing.length >= maximumLocationsPerEvent) {
        throw new EventLocationError("LOCATION_LIMIT_REACHED", `An event can have at most ${maximumLocationsPerEvent} locations.`);
      }
      const location = await tx.eventLocation.create({
        data: {
          eventId,
          name: input.name,
          normalizedName: normalizeLocationName(input.name),
          address: input.address,
          firstDay: input.firstDay,
          lastDay: input.lastDay,
          capacity: input.capacity,
          registrationClosesOn: input.registrationClosesOn,
          isActive: input.isActive,
          sortOrder: existing.length === 0 ? 0 : Math.max(...existing.map((row) => row.sortOrder)) + 1,
        },
      });
      await tx.auditLog.create({ data: {
        eventId, actorUserId, action: "EVENT_LOCATION_CREATED", entityType: "EventLocation", entityId: location.id,
        correlationId: randomUUID(), summary: `Added location ${location.name}.`,
        metadata: { capacity: location.capacity, hasOwnDates: Boolean(location.firstDay || location.lastDay || location.registrationClosesOn) },
      } });
      return location;
    }, { timeout: locationTransactionTimeoutMs });
    return serialize(created, { occupied: 0, registrations: 0 });
  } catch (error) {
    return nameTaken(error);
  }
}

/**
 * Edits one location. The location row is locked first (the same lock a club
 * registration takes to claim seats), so a capacity cut cannot slip under
 * seats a racing registration is taking: the new capacity may not be below the
 * people already registered there.
 */
export async function updateEventLocation(eventId: string, locationId: string, actorUserId: string, rawInput: unknown) {
  const input = eventLocationUpdateSchema.parse(rawInput);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const current = await lockEventLocation(tx, eventId, locationId);
      if (!current) throw new EventLocationError("LOCATION_NOT_FOUND", "That location was not found for this event.");
      const next = {
        firstDay: input.firstDay === undefined ? current.firstDay : input.firstDay,
        lastDay: input.lastDay === undefined ? current.lastDay : input.lastDay,
        registrationClosesOn: input.registrationClosesOn === undefined ? current.registrationClosesOn : input.registrationClosesOn,
      };
      const dateProblem = locationDateProblem(next);
      if (dateProblem) throw new EventLocationError("LOCATION_INVALID", dateProblem.message);
      const occupied = await countLocationSeats(tx, locationId);
      if (input.capacity !== undefined && input.capacity !== null && input.capacity < occupied) {
        throw new EventLocationError(
          "LOCATION_CAPACITY_BELOW_USAGE",
          `${occupied} ${occupied === 1 ? "person is" : "people are"} already registered at ${current.name}. Set the capacity to at least ${occupied}.`,
        );
      }
      const updated = await tx.eventLocation.update({
        where: { id: locationId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name, normalizedName: normalizeLocationName(input.name) }),
          ...(input.address === undefined ? {} : { address: input.address }),
          ...(input.firstDay === undefined ? {} : { firstDay: input.firstDay }),
          ...(input.lastDay === undefined ? {} : { lastDay: input.lastDay }),
          ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
          ...(input.registrationClosesOn === undefined ? {} : { registrationClosesOn: input.registrationClosesOn }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
      });
      await tx.auditLog.create({ data: {
        eventId, actorUserId, action: "EVENT_LOCATION_UPDATED", entityType: "EventLocation", entityId: locationId,
        correlationId: randomUUID(), summary: `Updated location ${updated.name}.`,
        metadata: {
          fields: Object.keys(input),
          activeChanged: input.isActive !== undefined && input.isActive !== current.isActive,
          capacityChanged: input.capacity !== undefined && input.capacity !== current.capacity,
        },
      } });
      const registrations = await tx.registration.count({ where: { locationId } });
      return serialize(updated, { occupied, registrations });
    }, { timeout: locationTransactionTimeoutMs });
  } catch (error) {
    return nameTaken(error);
  }
}

/** Saves a new display order. `orderedIds` must be exactly the event's locations. */
export async function reorderEventLocations(eventId: string, actorUserId: string, rawInput: unknown) {
  const { orderedIds } = eventLocationOrderSchema.parse(rawInput);
  await getPrisma().$transaction(async (tx) => {
    await lockEventForLocations(tx, eventId);
    const existing = await tx.eventLocation.findMany({ where: { eventId }, select: { id: true } });
    const known = new Set(existing.map((row) => row.id));
    if (known.size !== orderedIds.length || orderedIds.some((id) => !known.has(id))) {
      throw new EventLocationError("LOCATION_ORDER_MISMATCH", "The list of locations changed. Refresh the page and reorder again.");
    }
    for (const [position, id] of orderedIds.entries()) {
      await tx.eventLocation.update({ where: { id }, data: { sortOrder: position } });
    }
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "EVENT_LOCATIONS_REORDERED", entityType: "Event", entityId: eventId,
      correlationId: randomUUID(), summary: "Reordered the event's locations.", metadata: { count: orderedIds.length },
    } });
  }, { timeout: locationTransactionTimeoutMs });
  return listEventLocations(eventId);
}

/**
 * Deletes a location no registration has ever used. Any registration naming it
 * (of any status) refuses the delete: deactivate it instead. The row lock is
 * the one registrations take, and the foreign key backs it up (RESTRICT).
 */
export async function deleteEventLocation(eventId: string, locationId: string, actorUserId: string) {
  try {
    await getPrisma().$transaction(async (tx) => {
      const current = await lockEventLocation(tx, eventId, locationId);
      if (!current) throw new EventLocationError("LOCATION_NOT_FOUND", "That location was not found for this event.");
      const used = await tx.registration.count({ where: { locationId } });
      if (used > 0) {
        throw new EventLocationError(
          "LOCATION_IN_USE",
          `${current.name} is used by ${used} registration${used === 1 ? "" : "s"}, so it can't be deleted. Deactivate it instead.`,
        );
      }
      await tx.eventLocation.delete({ where: { id: locationId } });
      await tx.auditLog.create({ data: {
        eventId, actorUserId, action: "EVENT_LOCATION_DELETED", entityType: "EventLocation", entityId: locationId,
        correlationId: randomUUID(), summary: `Deleted location ${current.name}.`, metadata: {},
      } });
    }, { timeout: locationTransactionTimeoutMs });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new EventLocationError("LOCATION_IN_USE", "A registration uses this location, so it can't be deleted. Deactivate it instead.");
    }
    throw error;
  }
  return listEventLocations(eventId);
}

/** Active locations, in order, for a registration picker. Seat counts are for display; the server checks again under the lock. */
export async function listPickableLocations(eventId: string) {
  return (await listEventLocations(eventId)).filter((location) => location.isActive);
}
