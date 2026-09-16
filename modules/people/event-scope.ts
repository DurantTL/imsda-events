import "server-only";

import { getPrisma } from "@/lib/prisma";

/**
 * Whether a person has any footprint in this event — as an account holder or
 * as an attendee. Person-level staff notes are event-scoped like every other
 * resource in this app, so this is the check a person-notes route needs
 * before it will read or write against a person id.
 */
export async function personBelongsToEvent(eventId: string, personId: string) {
  const prisma = getPrisma();
  const [asAccountHolder, asAttendee] = await Promise.all([
    prisma.registration.findFirst({ where: { eventId, accountHolderPersonId: personId }, select: { id: true } }),
    prisma.registrationAttendee.findFirst({ where: { eventId, personId }, select: { id: true } }),
  ]);
  return Boolean(asAccountHolder || asAttendee);
}
