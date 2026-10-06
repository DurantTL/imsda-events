import "server-only";

import { getPrisma } from "@/lib/prisma";
import { effectiveLocationDates } from "@/modules/event-locations/domain";
import { getClubEventRecords } from "@/modules/reporting/club-event-reports-repository";
import { assignmentKey } from "@/modules/reporting/club-event-reports";
import { buildClubPacket, withClubPacketAssignment, type ClubPacket } from "@/modules/reporting/club-packet";

export const CONFERENCE_NAME = "IMSDA Events";

/**
 * One club's printable packet (Q1, #411): the same active-registration data
 * the four Camporee reports build from, narrowed to a single club and
 * combined with the event's dates and this club's assignment. Returns null
 * when the club has no active registration for this event, so a stale or
 * mistyped organization id never renders an empty packet.
 */
export async function getClubPacketData(eventId: string, organizationId: string, teamKey = ""): Promise<ClubPacket | null> {
  const [event, { clubs, assignments, earlyBirdDeadline }] = await Promise.all([
    getPrisma().event.findUnique({
      where: { id: eventId },
      select: { name: true, startsAt: true, endsAt: true, timezone: true },
    }),
    getClubEventRecords(eventId),
  ]);
  if (!event) return null;
  // One club's registration: with teams (#809) a club has several, so the team's key picks the one.
  const club = clubs.find((candidate) => candidate.organizationId === organizationId && (candidate.teamKey ?? "") === teamKey);
  if (!club) return null;

  // The location the club registered at (#413): its name, address, and dates
  // (the event's when the location sets none) go on the packet.
  const location = club.locationId
    ? await getPrisma().eventLocation.findUnique({
        where: { id: club.locationId },
        select: { name: true, address: true, firstDay: true, lastDay: true },
      })
    : null;
  const dates = location ? effectiveLocationDates({ ...event, registrationClosesOn: null }, { ...location, registrationClosesOn: null }) : null;

  const packet = buildClubPacket(club, {
    name: event.name,
    conferenceName: CONFERENCE_NAME,
    // A date-only day at midday UTC reads as the same calendar day in the event's time zone.
    startsOn: dates ? `${dates.firstDay}T12:00:00.000Z` : event.startsAt.toISOString(),
    endsOn: dates ? `${dates.lastDay}T12:00:00.000Z` : event.endsAt.toISOString(),
    timezone: event.timezone,
    earlyBirdDeadline,
    lateRateApplied: false,
  });
  if (location && dates) {
    packet.club.location = { name: location.name, address: location.address, firstDay: dates.firstDay, lastDay: dates.lastDay };
  }
  return withClubPacketAssignment(packet, assignments.get(assignmentKey(organizationId, teamKey)) ?? null);
}
