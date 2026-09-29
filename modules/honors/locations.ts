import type { Prisma } from "@prisma/client";

/**
 * Honors Weekend sites (#589), read-only. A session belongs to at most one
 * `EventLocation`; a club registration picks one (`Registration.locationId`,
 * #413). Classes get their site from their session. A session with no site is
 * shown at every site.
 *
 * These helpers only read. The club's location pick, its capacity and the
 * settings screens belong to the event-locations module (#413).
 */

type Client = Prisma.TransactionClient;

/** Whether a session (by its site) is offered to a club registered at `registrationLocationId`. */
export function sessionVisibleAtLocation(sessionLocationId: string | null | undefined, registrationLocationId: string | null | undefined) {
  return !sessionLocationId || sessionLocationId === registrationLocationId;
}

export const chooseLocationFirstMessage = "Choose your location first.";

export function differentLocationMessage(className: string, siteName: string | null) {
  return `${className} isn't offered at ${siteName ? `your location, ${siteName}` : "your location"}.`;
}

export function locationChangeBlockedMessage(siteName: string) {
  return `Remove this club's class picks at ${siteName} before changing location.`;
}

/**
 * The refusal message for changing a club registration's location away from
 * `currentLocationId`, or null when nothing blocks it. Blocks when the
 * registration still holds class picks in a session at that site. Picks in
 * sessions with no site, or in all-sessions classes, stay valid at any site.
 * Nothing is removed. #413's change-location path calls this inside its
 * transaction, before it saves the new location.
 */
export async function locationChangeBlock(client: Client, registrationId: string, currentLocationId: string | null) {
  if (!currentLocationId) return null;
  const picks = await client.honorEnrollment.count({
    where: { registrationId, offering: { session: { locationId: currentLocationId } } },
  });
  if (picks === 0) return null;
  const location = await client.eventLocation.findUnique({ where: { id: currentLocationId }, select: { name: true } });
  return locationChangeBlockedMessage(location?.name ?? "the current site");
}
