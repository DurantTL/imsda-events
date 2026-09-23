import "server-only";

import { getPrisma } from "@/lib/prisma";
import { resolveEventContext } from "@/modules/events/selection";

/**
 * Pathfinder event managers (#387): staff who are event administrators on a
 * club event (one billed to clubs) oversee the clubs registered for it — each
 * club's roster with ages only, and every club's monthly reports — view
 * only, and for that event only (decision).
 */
export async function resolveClubOversight(requestedEventId?: string) {
  const context = await resolveEventContext(requestedEventId);
  const event = await getPrisma().event.findUnique({
    where: { id: context.event.id },
    select: { id: true, name: true, billingMode: true },
  });
  const clubEvent = event?.billingMode === "DEFERRED_ORGANIZATION_INVOICE";
  const manager = context.user.globalRole === "SYSTEM_ADMIN" || context.membership?.role === "EVENT_ADMIN";
  return { ...context, allowed: Boolean(event && clubEvent && manager), clubEvent };
}

/** Clubs with an active registration for this event. */
export async function listRegisteredClubs(eventId: string) {
  const registrations = await getPrisma().clubEventRegistration.findMany({
    where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
    orderBy: { organization: { name: "asc" } },
    select: {
      organization: { select: { id: true, name: true, parentOrganization: { select: { name: true } } } },
      registration: { select: { confirmationCode: true, _count: { select: { attendees: true } } } },
    },
  });
  return registrations.map((row) => ({
    organizationId: row.organization.id,
    name: row.organization.name,
    sponsoringChurch: row.organization.parentOrganization?.name ?? null,
    confirmationCode: row.registration.confirmationCode,
    attendeeCount: row.registration._count.attendees,
  }));
}

export async function isClubRegisteredForEvent(eventId: string, organizationId: string) {
  const row = await getPrisma().clubEventRegistration.findFirst({
    where: { eventId, organizationId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
    select: { id: true },
  });
  return Boolean(row);
}
