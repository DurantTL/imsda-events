import "server-only";

import type { LocationWaitlistChangeKind, Prisma } from "@prisma/client";

/**
 * Location waitlists (#599). Waitlist entries keep the event-wide `position`
 * they always had (it is unique per event); a club's place in line at its
 * location is how many waiting clubs at that same location are at or ahead of
 * it, so order is first come first served per location.
 */

type Tx = Prisma.TransactionClient;

/**
 * The club's place in line at its location: 1 for the next club to be offered a
 * seat. `null` when the registration has no location or no waiting entry.
 */
export async function locationWaitlistPlace(tx: Tx, registrationId: string, locationId: string | null | undefined): Promise<number | null> {
  // No location: nothing to look up, so an event without locations never reaches the database here.
  if (!locationId) return null;
  const entry = await tx.registrationWaitlistEntry.findUnique({
    where: { registrationId },
    select: { position: true, status: true },
  });
  if (!entry || entry.status !== "WAITING") return null;
  return tx.registrationWaitlistEntry.count({
    where: {
      status: "WAITING",
      position: { lte: entry.position },
      // Waiting clubs only, as the staff list and the portal show them, so "#N" agrees with both.
      registration: { locationId, status: "WAITLISTED" },
    },
  });
}

/**
 * Records that a club joined, was promoted from, or was removed from a
 * location's waitlist, in the caller's transaction. The daily digest reads
 * these rows. A registration with no location records nothing. `place` is the
 * club's place in line to show: after joining, or where it stood before it
 * left. Never sends anything: the row is data, and the digest is sent after
 * commit.
 */
export async function recordLocationWaitlistChange(
  tx: Tx,
  input: { registrationId: string; locationId: string | null | undefined; kind: LocationWaitlistChangeKind; place: number | null; now?: Date },
) {
  if (!input.locationId) return null;
  const registration = await tx.registration.findUnique({
    where: { id: input.registrationId },
    select: {
      eventId: true,
      locationId: true,
      confirmationCode: true,
      location: { select: { name: true } },
      _count: { select: { attendees: true } },
      clubRegistration: { select: { organization: { select: { name: true } } } },
    },
  });
  if (!registration?.locationId || !registration.location) return null;
  return tx.locationWaitlistChange.create({
    data: {
      eventId: registration.eventId,
      locationId: registration.locationId,
      registrationId: input.registrationId,
      kind: input.kind,
      clubName: registration.clubRegistration?.organization.name ?? `Registration ${registration.confirmationCode}`,
      locationName: registration.location.name,
      attendeeCount: registration._count.attendees,
      place: input.place,
      ...(input.now ? { occurredAt: input.now } : {}),
    },
    select: { id: true },
  });
}

/** Waitlisted clubs at the given locations, each with its place in line there, for the coordinator portal and staff lists. */
export async function listWaitingClubsAtLocations(
  client: Pick<Tx, "registrationWaitlistEntry">,
  locationIds: readonly string[],
) {
  if (locationIds.length === 0) return [];
  const entries = await client.registrationWaitlistEntry.findMany({
    where: { status: "WAITING", registration: { locationId: { in: [...locationIds] }, status: "WAITLISTED" } },
    orderBy: { position: "asc" },
    select: {
      position: true,
      joinedAt: true,
      attendeeCount: true,
      registration: {
        select: {
          id: true,
          eventId: true,
          locationId: true,
          confirmationCode: true,
          event: { select: { name: true } },
          location: { select: { name: true } },
          clubRegistration: { select: { organization: { select: { name: true } } } },
        },
      },
    },
  });
  const placeByLocation = new Map<string, number>();
  return entries.map((entry) => {
    const locationId = entry.registration.locationId as string;
    const place = (placeByLocation.get(locationId) ?? 0) + 1;
    placeByLocation.set(locationId, place);
    return {
      registrationId: entry.registration.id,
      eventId: entry.registration.eventId,
      eventName: entry.registration.event.name,
      locationId,
      locationName: entry.registration.location?.name ?? "",
      clubName: entry.registration.clubRegistration?.organization.name ?? `Registration ${entry.registration.confirmationCode}`,
      confirmationCode: entry.registration.confirmationCode,
      attendeeCount: entry.attendeeCount,
      place,
      joinedAt: entry.joinedAt.toISOString(),
    };
  });
}

/**
 * The waitlisted clubs at every location this Area Coordinator is set as the
 * coordinator of, for the coordinator portal (#599), while their Area
 * Coordinator grant is active.
 */
export async function listWaitingClubsForCoordinator(
  client: Pick<Tx, "eventLocation" | "registrationWaitlistEntry">,
  coordinatorAccountId: string,
  now = new Date(),
) {
  const locations = await client.eventLocation.findMany({
    // Only while the coordinator's grant is active and the account enabled: a revoked or expired coordinator sees nothing.
    where: {
      coordinatorAccountId,
      coordinator: {
        disabledAt: null,
        areaCoordinatorGrant: { is: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
      },
    },
    orderBy: [{ eventId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, eventId: true, event: { select: { name: true } } },
  });
  const waiting = await listWaitingClubsAtLocations(client, locations.map((location) => location.id));
  return locations.map((location) => ({
    locationId: location.id,
    locationName: location.name,
    eventId: location.eventId,
    eventName: location.event.name,
    clubs: waiting.filter((club) => club.locationId === location.id),
  }));
}
