import type { Prisma } from "@prisma/client";

/**
 * Honors Weekend sites (#589), read-only. A session belongs to at most one
 * `EventLocation`, and so does an all-sessions class (`HonorOffering.locationId`);
 * a single-session class takes its site from its session. A club registration
 * picks one site (`Registration.locationId`, #413). A session or class with no
 * site is shown at every site.
 *
 * These helpers only read. The club's location pick, its capacity and the
 * settings screens belong to the event-locations module (#413).
 */

type Client = Prisma.TransactionClient;

/** Whether a session or class (by its site) is offered to a club registered at `registrationLocationId`. */
export function sessionVisibleAtLocation(sessionLocationId: string | null | undefined, registrationLocationId: string | null | undefined) {
  return !sessionLocationId || sessionLocationId === registrationLocationId;
}

/** The site a class is at: its session's, or its own for an all-sessions class. */
export function offeringSiteId(offering: {
  span: string;
  locationId?: string | null;
  session?: { locationId: string | null } | null;
}) {
  return offering.span === "ALL_SESSIONS" ? offering.locationId ?? null : offering.session?.locationId ?? null;
}

/**
 * What the class edit form sends for the site: nothing unless it changed, so a
 * legacy class with no site, or one clubs have picked (its site select isn't
 * shown), can still have its seats, teacher and room edited.
 */
export function siteChangePatch(currentLocationId: string | null, formValue: FormDataEntryValue | null): { locationId?: string | null } {
  if (formValue === null) return {};
  const next = String(formValue) || null;
  return next === currentLocationId ? {} : { locationId: next };
}

export const chooseLocationFirstMessage = "Choose your location first.";

export function differentLocationMessage(className: string, siteName: string | null) {
  return `${className} isn't offered at ${siteName ? `your location, ${siteName}` : "your location"}.`;
}

export function locationChangeBlockedMessage(siteName: string) {
  return `Remove this club's class picks at ${siteName} before changing location.`;
}

/** Whether the event has any active location, i.e. whether sessions and all-sessions classes must name a site. */
export async function eventHasActiveLocations(client: Client, eventId: string) {
  return (await client.eventLocation.count({ where: { eventId, isActive: true } })) > 0;
}

/**
 * The refusal message for changing a club registration's location away from
 * `currentLocationId`, or null when nothing blocks it. Blocks when the
 * registration still holds class picks at that site: in a session there, or in
 * an all-sessions class there. Picks in classes with no site stay valid at any
 * site. Nothing is removed. Every path that changes a registration's location
 * calls this inside its transaction, before it saves the new location.
 */
export async function locationChangeBlock(client: Client, registrationId: string, currentLocationId: string | null) {
  if (!currentLocationId) return null;
  const picks = await client.honorEnrollment.count({
    where: {
      registrationId,
      offering: { OR: [{ session: { locationId: currentLocationId } }, { locationId: currentLocationId }] },
    },
  });
  if (picks === 0) return null;
  const location = await client.eventLocation.findUnique({ where: { id: currentLocationId }, select: { name: true } });
  return locationChangeBlockedMessage(location?.name ?? "the current site");
}

/**
 * Whether moving class picks to a registration at `receivingLocationId` would
 * strand any: a pick at a site other than the receiver's. Picks in classes with
 * no site are fine anywhere. Used by member transfers.
 */
export async function crossSitePickCount(client: Client, attendeeId: string, registrationId: string, receivingLocationId: string | null) {
  // SQL's "<>" leaves out NULL, so a class with no site never counts as another site.
  const otherSite = { not: receivingLocationId ?? null };
  return client.honorEnrollment.count({
    where: {
      registrationAttendeeId: attendeeId,
      registrationId,
      OR: [{ offering: { session: { locationId: otherSite } } }, { offering: { locationId: otherSite } }],
    },
  });
}
