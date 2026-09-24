import "server-only";

import { getRosterAccessState } from "@/modules/club-rosters/access";
import { getClubAssignmentForClub } from "@/modules/club-registrations/assignments-repository";

/**
 * The club director's read-only view of staff's assignments (#410). Access is
 * decided here, not by the caller: only someone whose roster is OPEN for this
 * exact club (their own club role, own session, second step done) reads it,
 * and the lookup is keyed on that club, so a director of one club can never
 * read another club's assignment by changing the URL. Returns null for every
 * other state, and when staff haven't set anything yet.
 */
export async function loadDirectorClubAssignment(organizationId: string, eventId: string) {
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  return getClubAssignmentForClub(eventId, access.club.organizationId);
}
