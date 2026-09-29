import "server-only";

import type { Prisma } from "@prisma/client";
import { isDeadlockError, isLockTimeoutError } from "@/lib/prisma-errors";
import {
  EventLocationError,
  locationBusyMessage,
} from "@/modules/event-locations/errors";
import {
  evaluateLocationPhase,
  locationFullMessage,
  locationHasRoom,
  locationLifecycleSource,
  remainingLocationSeats,
} from "@/modules/event-locations/domain";
import {
  activeRegistrationStatuses,
  type EventLifecycleSource,
} from "@/modules/events/lifecycle";

/**
 * Admission of a registration to one location of a multi-location event
 * (#413), used inside the same transaction as the club registration submit
 * and amend paths.
 *
 * Capacity counts people exactly like `Event.capacity`: attendee rows of
 * SUBMITTED or CONFIRMED registrations. The location row is locked FOR UPDATE
 * first, so two directors racing for the last seats take turns; the
 * surrounding SERIALIZABLE transaction is the backstop (a loser that read a
 * stale count fails to commit and its retry sees the winner's seats).
 */

type Tx = Prisma.TransactionClient;

export type LockedLocation = {
  id: string;
  eventId: string;
  name: string;
  address: string | null;
  firstDay: string | null;
  lastDay: string | null;
  capacity: number | null;
  registrationClosesOn: string | null;
  isActive: boolean;
};

/**
 * Locks one location row and returns it, or `null` when the event has no such
 * location. Only the lock wait is bounded (5s, then `LOCATION_BUSY`); waits
 * after it are not.
 */
export async function lockEventLocation(tx: Tx, eventId: string, locationId: string): Promise<LockedLocation | null> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  let rows: LockedLocation[];
  try {
    rows = await tx.$queryRaw<LockedLocation[]>`
      SELECT "id", "eventId", "name", "address", "firstDay", "lastDay", "capacity",
             "registrationClosesOn", "isActive"
      FROM "EventLocation"
      WHERE "id" = ${locationId} AND "eventId" = ${eventId}
      FOR UPDATE`;
  } catch (error) {
    // A deadlock (two requests taking locations in opposite orders) is busy too: nothing was written here,
    // and the auto-promotion loop's savepoint skips the candidate (#599).
    if (isLockTimeoutError(error) || isDeadlockError(error)) throw new EventLocationError("LOCATION_BUSY", locationBusyMessage);
    throw error;
  }
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  return rows[0] ?? null;
}

/** People registered at a location, counted like the event-level capacity. */
export async function countLocationSeats(tx: Tx, locationId: string, excludeRegistrationId?: string) {
  return tx.registrationAttendee.count({
    where: {
      registration: {
        locationId,
        status: { in: [...activeRegistrationStatuses] },
        ...(excludeRegistrationId ? { id: { not: excludeRegistrationId } } : {}),
      },
    },
  });
}

export async function countActiveLocations(tx: Tx, eventId: string) {
  return tx.eventLocation.count({ where: { eventId, isActive: true } });
}

export type LocationSeatCheck = {
  eventId: string;
  locationId: string | null | undefined;
  requestedSeats: number;
  requirePick: boolean;
  excludeRegistrationId?: string;
  lock?: boolean;
  /**
   * The event's waitlist is on (#599): a location without room for the request
   * is not refused with LOCATION_FULL; the location is returned with
   * `waitlisted: true` so the registration joins that location's waitlist.
   */
  waitlistIfFull?: boolean;
};

/** A locked location, and whether the request did not fit and should be waitlisted there. */
export type AdmittedLocation = LockedLocation & { waitlisted: boolean };

/**
 * Checks and locks the location a registration takes seats at.
 *
 * - `requirePick`: a new pick (submit, or a switch). When the event has active
 *   locations a location is required, and it must be active. An unchanged
 *   registration keeps a location that has since been deactivated.
 * - `requestedSeats`: the people this registration will hold there.
 * - `excludeRegistrationId`: the registration being amended, so its own seats
 *   are not counted against itself.
 * - `lock: false` reads without the row lock (an amendment preview).
 *
 * - `waitlistIfFull`: a full location is returned with `waitlisted: true`
 *   instead of throwing LOCATION_FULL (#599). The lock is still held, so the
 *   caller's waitlist place is decided under it.
 *
 * Returns the location (or `null` for none). Throws `EventLocationError`:
 * LOCATION_REQUIRED, LOCATION_INVALID, LOCATION_FULL, LOCATION_BUSY.
 */
export async function checkLocationSeats(
  tx: Tx,
  input: LocationSeatCheck,
  /** Runs once the location is loaded and locked, before its seats are counted: "closed" is reported before "full". */
  beforeSeatCheck?: (location: LockedLocation) => void,
): Promise<AdmittedLocation | null> {
  if (!input.locationId) {
    if (input.requirePick && (await countActiveLocations(tx, input.eventId)) > 0) {
      throw new EventLocationError("LOCATION_REQUIRED", "Choose a location for your registration.");
    }
    return null;
  }
  let location: LockedLocation | null;
  if (input.lock === false) {
    location = await tx.eventLocation.findFirst({
      where: { id: input.locationId, eventId: input.eventId },
      select: {
        id: true, eventId: true, name: true, address: true, firstDay: true, lastDay: true,
        capacity: true, registrationClosesOn: true, isActive: true,
      },
    });
  } else {
    location = await lockEventLocation(tx, input.eventId, input.locationId);
  }
  if (!location) throw new EventLocationError("LOCATION_INVALID", "That location isn't part of this event. Refresh the page and choose again.");
  if (input.requirePick && !location.isActive) {
    throw new EventLocationError("LOCATION_INVALID", `${location.name} is no longer taking registrations. Choose another location.`);
  }
  beforeSeatCheck?.(location);
  const occupied = await countLocationSeats(tx, location.id, input.excludeRegistrationId);
  if (!locationHasRoom(location.capacity, occupied, input.requestedSeats)) {
    if (input.waitlistIfFull) return { ...location, waitlisted: true };
    throw new EventLocationError("LOCATION_FULL", locationFullMessage(location.name, remainingLocationSeats(location.capacity, occupied)));
  }
  return { ...location, waitlisted: false };
}

export type LocationAdmission<E extends EventLifecycleSource> = {
  locationId: string | null;
  location: LockedLocation | null;
  /** The location had no room and the event waitlist is on: join that location's waitlist (#599). */
  waitlisted: boolean;
  /** The event's lifecycle with this location's own closing date and last day applied. */
  lifecycle: E;
};

/** `checkLocationSeats` plus the event lifecycle for the chosen location. */
export async function admitToLocation<E extends EventLifecycleSource>(
  tx: Tx,
  input: LocationSeatCheck & {
    event: E;
    /** Called with the location's lifecycle before seats are counted; throw to refuse. */
    beforeSeatCheck?: (lifecycle: E, location: LockedLocation) => void;
  },
): Promise<LocationAdmission<E>> {
  const guard = input.beforeSeatCheck;
  const location = await checkLocationSeats(
    tx,
    input,
    guard ? (locked) => guard(locationLifecycleSource(input.event, locked), locked) : undefined,
  );
  return {
    locationId: location?.id ?? null,
    location,
    waitlisted: location?.waitlisted ?? false,
    lifecycle: location ? locationLifecycleSource(input.event, location) : input.event,
  };
}

/** Whether a location still takes registrations at `now`, with the message a director sees when not. */
export function locationOpenProblem(
  event: EventLifecycleSource,
  location: { name: string; firstDay: string | null; lastDay: string | null; registrationClosesOn: string | null },
  now: Date,
) {
  const phase = evaluateLocationPhase(event, location, now);
  if (phase === "OPEN") return null;
  if (phase === "UPCOMING") return `Registration for ${location.name} isn't open yet.`;
  if (phase === "CLOSED") return `Registration for ${location.name} has closed.`;
  return "That location isn't available.";
}
