import "server-only";

import { getPrisma } from "@/lib/prisma";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import type { ClubRole } from "@/modules/organizations/director-grants-domain";

/**
 * The one question every club screen asks (#354): which clubs does this
 * signed-in person hold a role in right now, and which role? Only unrevoked
 * grants inside their date window, on active clubs, count. What the role
 * allows is `clubCapabilities` (#375).
 */

export type DirectedClub = {
  organizationId: string;
  name: string;
  role: ClubRole;
  sponsoringChurch: string | null;
};

export async function listDirectedClubs(attendeeAccountId: string, now = new Date()): Promise<DirectedClub[]> {
  const grants = await getPrisma().clubDirectorGrant.findMany({
    where: {
      attendeeAccountId,
      revokedAt: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      organization: { type: "CLUB", isActive: true },
    },
    orderBy: [{ organization: { name: "asc" } }, { role: "asc" }],
    select: {
      role: true,
      organization: {
        select: {
          id: true,
          name: true,
          parentOrganization: { select: { name: true } },
        },
      },
    },
  });

  // Roles sort in enum order (director, deputy, registrar, reporter), so the
  // first row per club is the broadest role.
  const clubs = new Map<string, DirectedClub>();
  for (const grant of grants) {
    if (clubs.has(grant.organization.id)) continue;
    clubs.set(grant.organization.id, {
      organizationId: grant.organization.id,
      name: grant.organization.name,
      role: grant.role,
      sponsoringChurch: grant.organization.parentOrganization?.name ?? null,
    });
  }
  return [...clubs.values()];
}

export async function getDirectedClubsForCurrentAttendee(now = new Date()) {
  const { account } = await getCurrentAttendee();
  if (!account) return [];
  return listDirectedClubs(account.id, now);
}

/**
 * The club if the signed-in person directs it now, otherwise null. Callers
 * answer null with a 404 so a club's existence is never revealed to people
 * who do not direct it.
 */
export async function findDirectedClub(organizationId: string, now = new Date()) {
  const clubs = await getDirectedClubsForCurrentAttendee(now);
  return clubs.find((club) => club.organizationId === organizationId) ?? null;
}
