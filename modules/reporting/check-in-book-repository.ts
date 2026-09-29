import "server-only";

import { getPrisma } from "@/lib/prisma";
import { resolveLocationFilter, type LocationFilterOption } from "@/modules/event-locations/filter";
import { listRegistrations } from "@/modules/registrations/repository";
import {
  buildCheckInBook,
  checkInBookExtraOptions,
  type CheckInBook,
  type CheckInBookExtraOption,
  type CheckInBookStatus,
} from "@/modules/reporting/check-in-book";
import { getClubEventRecords } from "@/modules/reporting/club-event-reports-repository";

export type CheckInBookData = {
  book: CheckInBook;
  /** Attendee answers staff may pick for the extra column (never sensitive ones). */
  extraOptions: CheckInBookExtraOption[];
  /** The event's locations for the filter; empty when it has none (#413). */
  locations: LocationFilterOption[];
  /** The location the book is narrowed to, or null for all. */
  locationId: string | null;
};

/**
 * The check-in book for one event (#600). Events with club registrations
 * print one page per club; any other event prints one page per registration.
 * Returns null when the event does not exist.
 */
export async function getCheckInBookData(
  eventId: string,
  options: { statuses: readonly CheckInBookStatus[]; extraFieldKey?: string | null; location?: string | null },
): Promise<CheckInBookData | null> {
  const prisma = getPrisma();
  const [event, clubRegistrationCount] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, startsAt: true, endsAt: true, timezone: true },
    }),
    prisma.clubEventRegistration.count({ where: { eventId } }),
  ]);
  if (!event) return null;

  // An unknown or stale `location` falls back to every location (#413).
  const { locations, locationId, selected } = await resolveLocationFilter(eventId, options.location);
  const locationLabel = locations.length === 0 ? null : selected?.name ?? "All locations";
  const mode = clubRegistrationCount > 0 ? "CLUB" as const : "REGISTRATION" as const;
  const bookEvent = {
    name: event.name,
    startsOn: event.startsAt.toISOString(),
    endsOn: event.endsAt.toISOString(),
    timezone: event.timezone,
  };

  if (mode === "CLUB") {
    const { clubs, registrations } = await getClubEventRecords(eventId, { statuses: options.statuses, locationId });
    return {
      book: buildCheckInBook({ event: bookEvent, mode, clubs, registrations, extraFieldKey: options.extraFieldKey, locationLabel }),
      extraOptions: checkInBookExtraOptions(registrations),
      locations,
      locationId,
    };
  }

  const registrations = await listRegistrations(eventId, { statuses: options.statuses, locationId });
  return {
    book: buildCheckInBook({ event: bookEvent, mode, clubs: [], registrations, extraFieldKey: options.extraFieldKey, locationLabel }),
    extraOptions: checkInBookExtraOptions(registrations),
    locations,
    locationId,
  };
}
