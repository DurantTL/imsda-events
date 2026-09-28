import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { CONFERENCE_TIME_ZONE } from "@/modules/calendar/domain";

/**
 * Honors Weekend write-back (#487): when a Pathfinder's class enrollment
 * (#357–#360) shows they attended (checked in to the event), that completes
 * the honor, and it's written into the same year-round record `MemberHonorEntry`
 * keeps (#486) — the same record the club's own bulk marking writes to, so
 * the order list (`modules/honors/order-source.ts`) sees it exactly the same
 * way either way. `HonorWeekendCompletionLink` is unique on `enrollmentId`,
 * so an enrollment already written back is left out of the very query that
 * finds candidates: running this twice over the same roster writes nothing
 * the second time.
 */

type Snapshot = { clubRosterMemberId?: string };

/** The event's own date, in the conference's time zone, as the completion date. */
function eventCompletionDate(startsAt: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFERENCE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(startsAt);
}

export class HonorsWeekendWriteBackError extends Error {
  constructor(public readonly code: "EVENT_NOT_FOUND", message: string) {
    super(message);
    this.name = "HonorsWeekendWriteBackError";
  }
}

const WRITE_BACK_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };

/**
 * Writes back every checked-in Honors Weekend class enrollment at this event
 * that isn't already linked. An enrollment with no roster member behind it
 * (a one-off attendee never on the club's roster) has nowhere to write a
 * year-round record, so it's counted as skipped, not an error.
 */
export async function writeBackHonorsWeekendCompletions(eventId: string, actorUserId: string) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, startsAt: true } });
  if (!event) throw new HonorsWeekendWriteBackError("EVENT_NOT_FOUND", "That event could not be found.");
  const completionDate = eventCompletionDate(event.startsAt);

  const candidates = await prisma.honorEnrollment.findMany({
    where: {
      eventId,
      weekendCompletion: null,
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
    },
    select: {
      id: true,
      organizationId: true,
      offering: { select: { honorId: true } },
      registrationAttendee: {
        select: { profileSnapshot: true, checkIns: { where: { undoneAt: null }, select: { id: true }, take: 1 } },
      },
    },
  });

  const eligible = candidates.filter((candidate) => candidate.registrationAttendee.checkIns.length > 0);
  const memberIds = eligible
    .map((candidate) => (candidate.registrationAttendee.profileSnapshot as Snapshot).clubRosterMemberId)
    .filter((id): id is string => Boolean(id));
  const members = memberIds.length
    ? await prisma.clubRosterMember.findMany({
      where: { id: { in: memberIds }, status: { not: "REMOVED" }, personId: { not: null } },
      select: { id: true, personId: true },
    })
    : [];
  const personByMember = new Map(members.map((member) => [member.id, member.personId!]));

  const toWrite = eligible
    .map((candidate) => {
      const memberId = (candidate.registrationAttendee.profileSnapshot as Snapshot).clubRosterMemberId;
      const personId = memberId ? personByMember.get(memberId) : undefined;
      return personId ? { enrollmentId: candidate.id, organizationId: candidate.organizationId, honorId: candidate.offering.honorId, personId } : null;
    })
    .filter((row): row is { enrollmentId: string; organizationId: string; honorId: string; personId: string } => row !== null);

  if (toWrite.length === 0) return { written: 0, skipped: candidates.length };

  await prisma.$transaction(async (tx) => {
    for (const row of toWrite) {
      const entry = await tx.memberHonorEntry.create({
        data: {
          personId: row.personId,
          honorId: row.honorId,
          status: "COMPLETED",
          completionDate,
          organizationId: row.organizationId,
          recordedByUserId: actorUserId,
        },
        select: { id: true },
      });
      await tx.honorWeekendCompletionLink.create({
        data: { enrollmentId: row.enrollmentId, memberHonorEntryId: entry.id },
      });
      await writeAuditLog({
        actorUserId,
        action: "HONORS_WEEKEND_COMPLETION_WRITTEN",
        entityType: "MemberHonorEntry",
        entityId: entry.id,
        summary: "Wrote an Honors Weekend class completion into a member's year-round honor record.",
        metadata: { eventId, organizationId: row.organizationId, honorId: row.honorId, enrollmentId: row.enrollmentId },
      }, tx);
    }
  }, WRITE_BACK_TRANSACTION);

  return { written: toWrite.length, skipped: candidates.length - toWrite.length };
}
