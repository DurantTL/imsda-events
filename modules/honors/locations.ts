import type { Prisma } from "@prisma/client";
import { evaluateLocationPhase, hasLocationEnded, locationLifecycleSource, type LocationDateSource } from "@/modules/event-locations/domain";
import { hasEventEnded, registrationClosedMessage, type EventLifecycleSource } from "@/modules/events/lifecycle";

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

/**
 * The one class-change deadline (#831): the registration's site close when the site has one, else the event's.
 * Direct picks, the director's screen and the class waitlist all ask this, so the line can't be jumped after
 * the site closes and the screen and the waitlist agree.
 */
export function classChangesOpen(event: EventLifecycleSource, location: LocationDateSource | null | undefined, now: Date) {
  return evaluateLocationPhase(event, location ?? null, now) === "OPEN";
}

/**
 * Whether the event or site has actually ended (its last day has passed), so a waitlist place can never be offered again.
 * Not the same as the registration close date passing: while the event is still to come, staff may extend the deadline,
 * and the line then picks up again in its original order (#831).
 */
export function classChangesEnded(event: Pick<EventLifecycleSource, "timezone" | "endsAt">, location: LocationDateSource | null | undefined, now: Date) {
  return hasLocationEnded(event, location ?? null, now);
}

/** Why class changes are closed, in words, for the refusal a director sees. */
export function classChangesClosedMessage(event: EventLifecycleSource, location: LocationDateSource | null | undefined, now: Date) {
  const source = locationLifecycleSource(event, location ?? null);
  if (hasEventEnded(source, now)) return registrationClosedMessage;
  return `Class choices closed${source.registrationClosesOn ? ` after ${source.registrationClosesOn}` : ""}.`;
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
  const places = picks === 0
    ? await client.honorClassWaitlistEntry.count({
      where: {
        registrationId,
        status: { in: ["WAITING", "OFFERED"] },
        offering: { OR: [{ session: { locationId: currentLocationId } }, { locationId: currentLocationId }] },
      },
    })
    : 0;
  if (picks === 0 && places === 0) return null;
  const location = await client.eventLocation.findUnique({ where: { id: currentLocationId }, select: { name: true } });
  const site = location?.name ?? "the current site";
  // Class waitlist places (#831) block a move too: they would be stranded at the old site, so they are left for the director to remove.
  return picks === 0 ? `Remove this club's class waitlist places at ${site} before changing location.` : locationChangeBlockedMessage(site);
}

/**
 * Whether moving class picks to a registration at `receivingLocationId` would
 * strand any: a pick at a site other than the receiver's. Picks in classes with
 * no site are fine anywhere. Used by member transfers.
 */
export async function crossSitePickCount(client: Client, attendeeId: string, registrationId: string, receivingLocationId: string | null) {
  // SQL's "<>" leaves out NULL, so a class with no site never counts as another site.
  const otherSite = { not: receivingLocationId ?? null };
  const atOtherSite = [{ offering: { session: { locationId: otherSite } } }, { offering: { locationId: otherSite } }];
  const picks = await client.honorEnrollment.count({ where: { registrationAttendeeId: attendeeId, registrationId, OR: atOtherSite } });
  // Open class waitlist places (#831) would be stranded at another site the same way a pick would.
  const places = await client.honorClassWaitlistEntry.count({
    where: { registrationAttendeeId: attendeeId, registrationId, status: { in: ["WAITING", "OFFERED"] }, OR: atOtherSite },
  });
  return picks + places;
}
