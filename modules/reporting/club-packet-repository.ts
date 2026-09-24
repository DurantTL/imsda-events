import "server-only";

import { getPrisma } from "@/lib/prisma";
import { getClubEventRecords } from "@/modules/reporting/club-event-reports-repository";
import { buildClubPacket, withClubPacketAssignment, type ClubPacket } from "@/modules/reporting/club-packet";

export const CONFERENCE_NAME = "IMSDA Events";

/**
 * One club's printable packet (Q1, #411): the same active-registration data
 * the four Camporee reports build from, narrowed to a single club and
 * combined with the event's dates and this club's assignment. Returns null
 * when the club has no active registration for this event, so a stale or
 * mistyped organization id never renders an empty packet.
 */
export async function getClubPacketData(eventId: string, organizationId: string): Promise<ClubPacket | null> {
  const [event, { clubs, assignments, earlyBirdDeadline }] = await Promise.all([
    getPrisma().event.findUnique({
      where: { id: eventId },
      select: { name: true, startsAt: true, endsAt: true, timezone: true },
    }),
    getClubEventRecords(eventId),
  ]);
  if (!event) return null;
  const club = clubs.find((candidate) => candidate.organizationId === organizationId);
  if (!club) return null;

  const packet = buildClubPacket(club, {
    name: event.name,
    conferenceName: CONFERENCE_NAME,
    startsOn: event.startsAt.toISOString(),
    endsOn: event.endsAt.toISOString(),
    timezone: event.timezone,
    earlyBirdDeadline,
    lateRateApplied: false,
  });
  return withClubPacketAssignment(packet, assignments.get(organizationId) ?? null);
}
