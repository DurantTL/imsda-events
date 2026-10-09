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
 * way either way. A class can teach several honors (#812), and completing it
 * completes each: one `HonorWeekendCompletionLink` per (enrollment, honor), unique
 * on that pair, so a pair already linked is never written again: running this
 * twice over the same roster writes nothing the second time. A member whose
 * latest entry for that honor is already COMPLETED gets no second entry.
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

export type HonorsWeekendWriteBackResult = {
  /** New COMPLETED entries appended to members' honor records (one per honor a class teaches). */
  written: number;
  /**
   * Enrollment honors already reflected in the member's record: linked by an
   * earlier (or concurrent) run, or the member's latest entry for that honor
   * was already COMPLETED (recorded by hand, say), so only the link was added.
   */
  alreadyRecorded: number;
  /** Enrollment honors not checked in, or with no roster member at the enrolling club to write to. */
  skipped: number;
};

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/**
 * Writes back every checked-in Honors Weekend class enrollment at this event
 * that isn't already linked. An enrollment with no roster member behind it at
 * the enrolling club (a one-off attendee, or a member of some other club) has
 * nowhere to write a year-round record, so it's counted as skipped, not an
 * error. When the member's latest entry for that honor is already COMPLETED,
 * no second entry is appended — the enrollment is linked to that entry and
 * counted as already recorded. Runs are serialized per event, and per person
 * and honor across events (two weekends at once never both append); a unique-key
 * race that still slips through is retried once, and the retry reports those
 * enrollments as already recorded rather than failing.
 */
export async function writeBackHonorsWeekendCompletions(eventId: string, actorUserId: string): Promise<HonorsWeekendWriteBackResult> {
  return runWriteBack(eventId, { userId: actorUserId });
}

/**
 * An instructor's completions (#833): writes back just these enrollments, only
 * those the instructor marked completed, attributed to the instructor's own
 * attendee account. The same transaction, locks, links and rules as the staff
 * run, so a pair already linked is never written twice and a member whose
 * latest entry is already COMPLETED gets no second one. The caller has already
 * checked the instructor teaches each enrollment's class.
 */
export async function writeBackInstructorCompletions(
  eventId: string,
  enrollmentIds: readonly string[],
  actorAccountId: string,
): Promise<HonorsWeekendWriteBackResult> {
  if (enrollmentIds.length === 0) return { written: 0, alreadyRecorded: 0, skipped: 0 };
  return runWriteBack(eventId, { accountId: actorAccountId }, { enrollmentIds: [...enrollmentIds] });
}

type WriteBackActor = { userId: string } | { accountId: string };
type WriteBackScope = { enrollmentIds: string[] };

async function runWriteBack(eventId: string, actor: WriteBackActor, scope?: WriteBackScope): Promise<HonorsWeekendWriteBackResult> {
  const event = await getPrisma().event.findUnique({ where: { id: eventId }, select: { id: true, startsAt: true } });
  if (!event) throw new HonorsWeekendWriteBackError("EVENT_NOT_FOUND", "That event could not be found.");
  const completionDate = eventCompletionDate(event.startsAt);
  try {
    return await writeBackOnce(eventId, completionDate, actor, scope);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return writeBackOnce(eventId, completionDate, actor, scope);
  }
}

type WriteRow = { enrollmentId: string; organizationId: string; honorId: string; personId: string };

async function writeBackOnce(eventId: string, completionDate: string, actor: WriteBackActor, scope?: WriteBackScope): Promise<HonorsWeekendWriteBackResult> {
  const actorUserId = "userId" in actor ? actor.userId : undefined;
  const actorAccountId = "accountId" in actor ? actor.accountId : undefined;
  return getPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`honors-weekend-write-back:${eventId}`}))`;
    const enrollments = await tx.honorEnrollment.findMany({
      where: { eventId, ...(scope ? { id: { in: scope.enrollmentIds } } : {}), registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
      select: {
        id: true,
        organizationId: true,
        weekendCompletions: { select: { honorId: true } },
        instructorMark: { select: { completed: true } },
        offering: { select: { honors: { select: { honorId: true }, orderBy: { position: "asc" } } } },
        registrationAttendee: {
          select: { profileSnapshot: true, checkIns: { where: { undoneAt: null }, select: { id: true }, take: 1 } },
        },
      },
    });
    // One candidate per (enrollment, honor the class teaches) not yet linked (#812).
    const pairs = enrollments.flatMap((enrollment) => {
      const linked = new Set(enrollment.weekendCompletions.map((link) => link.honorId));
      return enrollment.offering.honors.map((row) => ({ enrollment, honorId: row.honorId, linked: linked.has(row.honorId) }));
    });
    const linkedAlready = pairs.filter((pair) => pair.linked).length;
    const candidates = pairs
      .filter((pair) => !pair.linked)
      .map((pair) => ({ ...pair.enrollment, honorId: pair.honorId }));
    // An instructor's mark (#833) is a decision and governs: completed writes, anything else doesn't, whatever
    // the check-in says. With no mark, checking in to the event completes the honor, as it always has. An
    // instructor's own run (a scope) writes only what that instructor marked completed.
    const eligible = candidates.filter((candidate) => {
      if (scope) return candidate.instructorMark?.completed === true;
      return candidate.instructorMark ? candidate.instructorMark.completed : candidate.registrationAttendee.checkIns.length > 0;
    });
    const memberIds = eligible
      .map((candidate) => (candidate.registrationAttendee.profileSnapshot as Snapshot).clubRosterMemberId)
      .filter((id): id is string => Boolean(id));
    const members = memberIds.length
      ? await tx.clubRosterMember.findMany({
        where: { id: { in: memberIds }, status: { not: "REMOVED" }, personId: { not: null } },
        select: { id: true, personId: true, organizationId: true },
      })
      : [];
    const memberById = new Map(members.map((member) => [member.id, member]));

    const toWrite = eligible
      .map((candidate): WriteRow | null => {
        const memberId = (candidate.registrationAttendee.profileSnapshot as Snapshot).clubRosterMemberId;
        const member = memberId ? memberById.get(memberId) : undefined;
        // The roster member must belong to the club that enrolled them: a
        // snapshot pointing at another club's roster never writes there.
        if (!member || member.organizationId !== candidate.organizationId) return null;
        return { enrollmentId: candidate.id, organizationId: candidate.organizationId, honorId: candidate.honorId, personId: member.personId! };
      })
      .filter((row): row is WriteRow => row !== null);

    let written = 0;
    let linkedToExisting = 0;
    // Two Honors Weekend events can write back the same person and honor at
    // once, so the "is the latest entry already COMPLETED?" check is taken
    // under a per-person-and-honor lock, in one fixed order so runs never
    // deadlock one another.
    const personHonorKey = (row: WriteRow) => `${row.personId}:${row.honorId}`;
    toWrite.sort((a, b) => personHonorKey(a).localeCompare(personHonorKey(b)));
    for (const row of toWrite) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-honor-entry:${personHonorKey(row)}`}))`;
      const latest = await tx.memberHonorEntry.findFirst({
        // A voided entry (#591) is never the "already completed" one.
        where: { personId: row.personId, honorId: row.honorId, void: null },
        orderBy: { seq: "desc" },
        select: { id: true, status: true },
      });
      if (latest?.status === "COMPLETED") {
        await tx.honorWeekendCompletionLink.create({ data: { enrollmentId: row.enrollmentId, honorId: row.honorId, memberHonorEntryId: latest.id } });
        linkedToExisting += 1;
        continue;
      }
      const entry = await tx.memberHonorEntry.create({
        data: {
          personId: row.personId,
          honorId: row.honorId,
          status: "COMPLETED",
          completionDate,
          organizationId: row.organizationId,
          ...(actorUserId ? { recordedByUserId: actorUserId } : { recordedByAccountId: actorAccountId }),
        },
        select: { id: true },
      });
      await tx.honorWeekendCompletionLink.create({ data: { enrollmentId: row.enrollmentId, honorId: row.honorId, memberHonorEntryId: entry.id } });
      await writeAuditLog({
        actorUserId,
        action: "HONORS_WEEKEND_COMPLETION_WRITTEN",
        entityType: "MemberHonorEntry",
        entityId: entry.id,
        summary: "Wrote an Honors Weekend class completion into a member's year-round honor record.",
        metadata: { eventId, organizationId: row.organizationId, honorId: row.honorId, enrollmentId: row.enrollmentId, ...(actorAccountId ? { actorAttendeeAccountId: actorAccountId, byInstructor: true } : {}) },
      }, tx);
      written += 1;
    }
    if (linkedToExisting > 0) {
      await writeAuditLog({
        actorUserId,
        action: "HONORS_WEEKEND_COMPLETION_ALREADY_RECORDED",
        entityType: "Event",
        entityId: eventId,
        summary: `Linked ${linkedToExisting} Honors Weekend class completion${linkedToExisting === 1 ? "" : "s"} to honors already recorded as completed.`,
        metadata: { eventId, enrollmentCount: linkedToExisting, ...(actorAccountId ? { actorAttendeeAccountId: actorAccountId, byInstructor: true } : {}) },
      }, tx);
    }
    return { written, alreadyRecorded: linkedAlready + linkedToExisting, skipped: candidates.length - toWrite.length };
  }, WRITE_BACK_TRANSACTION);
}
