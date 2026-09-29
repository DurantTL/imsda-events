import "server-only";

import { getPrisma } from "@/lib/prisma";
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
};

/**
 * The check-in book for one event (#600). Events with club registrations
 * print one page per club; any other event prints one page per registration.
 * Returns null when the event does not exist.
 */
export async function getCheckInBookData(
  eventId: string,
  options: { statuses: readonly CheckInBookStatus[]; extraFieldKey?: string | null },
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

  const mode = clubRegistrationCount > 0 ? "CLUB" as const : "REGISTRATION" as const;
  const bookEvent = {
    name: event.name,
    startsOn: event.startsAt.toISOString(),
    endsOn: event.endsAt.toISOString(),
    timezone: event.timezone,
  };

  if (mode === "CLUB") {
    const { clubs, registrations } = await getClubEventRecords(eventId, { statuses: options.statuses });
    return {
      book: buildCheckInBook({ event: bookEvent, mode, clubs, registrations, extraFieldKey: options.extraFieldKey }),
      extraOptions: checkInBookExtraOptions(registrations),
    };
  }

  const registrations = await listRegistrations(eventId, { statuses: options.statuses });
  return {
    book: buildCheckInBook({ event: bookEvent, mode, clubs: [], registrations, extraFieldKey: options.extraFieldKey }),
    extraOptions: checkInBookExtraOptions(registrations),
  };
}
