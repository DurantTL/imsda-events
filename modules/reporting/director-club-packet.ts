import "server-only";

import { getPrisma } from "@/lib/prisma";
import { currentPricingSnapshot, perPersonPriceFromSnapshot } from "@/modules/club-registrations/per-person-price";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { getClubPacketData } from "@/modules/reporting/club-packet-repository";

/**
 * A club director's own packet (Q1, #411), gated exactly like
 * `loadDirectorClubAssignment` (#410): only when this club's roster access is
 * OPEN for the signed-in director, and always for their own club only — the
 * organization id never comes from the request, only from the verified
 * roster session, so a director can never fetch another club's packet by
 * editing the URL.
 *
 * The director never sees what the church owes (#621): the amount is removed
 * here, server-side, and the per-person price is shown instead.
 */
export async function loadDirectorClubPacket(organizationId: string, eventId: string, teamKey = "") {
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  const packet = await getClubPacketData(eventId, access.club.organizationId, teamKey);
  if (!packet) return null;
  const submission = await getPrisma().clubEventRegistration.findUnique({
    where: { eventId_organizationId_teamKey: { eventId, organizationId: access.club.organizationId, teamKey } },
    select: {
      registration: {
        select: {
          publicFormSubmission: { select: { pricingSnapshot: true } },
          // The latest amendment's pricing wins over the original submission's.
          operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
        },
      },
    },
  });
  return {
    ...packet,
    amountOwedCents: null,
    perPersonPrice: perPersonPriceFromSnapshot(submission ? currentPricingSnapshot(submission.registration) : null, true),
  };
}
