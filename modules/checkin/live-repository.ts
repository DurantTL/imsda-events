import { getPrisma } from "@/lib/prisma";
import {
  LIVE_CHANGES_LIMIT,
  collapseCheckInChanges,
  type LiveCheckInChanges,
} from "@/modules/checkin/live-changes";

/**
 * Attendees whose check-in state changed since `since` (#825), for the other
 * desk devices' live lists. Returns attendee ids and times, nothing else. The
 * server clock is read before the query so the caller's overlap window always
 * covers a commit that lands while this runs.
 */
export async function listCheckInChanges(eventId: string, since: Date): Promise<LiveCheckInChanges> {
  const now = new Date();
  const rows = await getPrisma().checkIn.findMany({
    where: {
      eventId,
      OR: [{ checkedInAt: { gte: since } }, { undoneAt: { gte: since } }],
    },
    select: { registrationAttendeeId: true, checkedInAt: true, undoneAt: true },
    orderBy: { checkedInAt: "desc" },
    take: LIVE_CHANGES_LIMIT,
  });
  return { now: now.toISOString(), changes: collapseCheckInChanges(rows) };
}
