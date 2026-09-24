import "server-only";

import { getRosterAccessState } from "@/modules/club-rosters/access";
import { getClubPacketData } from "@/modules/reporting/club-packet-repository";

/**
 * A club director's own packet (Q1, #411), gated exactly like
 * `loadDirectorClubAssignment` (#410): only when this club's roster access is
 * OPEN for the signed-in director, and always for their own club only — the
 * organization id never comes from the request, only from the verified
 * roster session, so a director can never fetch another club's packet by
 * editing the URL.
 */
export async function loadDirectorClubPacket(organizationId: string, eventId: string) {
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  return getClubPacketData(eventId, access.club.organizationId);
}
