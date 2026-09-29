import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  selectAccountBannerAnnouncements,
  type AccountBannerAnnouncement,
} from "@/modules/communications/account-banner-domain";
import { matchingRegistrationIdsForVerifiedEmail } from "@/modules/attendee-accounts/registrations-repository";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import type { DirectedClub } from "@/modules/organizations/director-access";

/**
 * Published HOME_BANNER announcements for a signed-in account (#590). An event
 * is linked when the account has an active registration for it, or directs or
 * deputises a club with an active club registration for it. That link is part
 * of the one announcement query, so an unlinked event's announcements are
 * never read. `clubs` is the caller's already-loaded `listDirectedClubs`.
 */
export async function listAccountBannerAnnouncements(
  account: { id: string; verifiedEmail: string },
  clubs: DirectedClub[],
  now = new Date(),
): Promise<AccountBannerAnnouncement[]> {
  const registrationIds = await matchingRegistrationIdsForVerifiedEmail(account.verifiedEmail);
  const clubIds = clubs
    .filter((club) => club.role === "DIRECTOR" || club.role === "DEPUTY")
    .map((club) => club.organizationId);
  if (registrationIds.length === 0 && clubIds.length === 0) return [];

  const activeStatus = { in: [...activeRegistrationStatuses] };
  const ownRegistration = { id: { in: registrationIds }, status: activeStatus };
  const clubRegistration = { organizationId: { in: clubIds }, registration: { status: activeStatus } };

  const rows = await getPrisma().announcement.findMany({
    where: {
      status: "PUBLISHED",
      placement: "HOME_BANNER",
      publishedAt: { lte: now },
      event: {
        OR: [
          ...(registrationIds.length > 0 ? [{ registrations: { some: ownRegistration } }] : []),
          ...(clubIds.length > 0 ? [{ clubRegistrations: { some: clubRegistration } }] : []),
        ],
      },
    },
    select: {
      id: true,
      eventId: true,
      title: true,
      body: true,
      audience: true,
      placement: true,
      status: true,
      priority: true,
      publishedAt: true,
      pinnedAt: true,
      event: {
        select: {
          name: true,
          slug: true,
          timezone: true,
          endsAt: true,
          registrations: { where: ownRegistration, take: 1, select: { id: true } },
          clubRegistrations: { where: clubRegistration, take: 1, select: { organizationId: true } },
        },
      },
    },
  });
  return selectAccountBannerAnnouncements(
    rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      title: row.title,
      body: row.body,
      audience: row.audience,
      placement: row.placement,
      status: row.status,
      priority: row.priority,
      publishedAt: row.publishedAt,
      pinnedAt: row.pinnedAt,
      event: {
        name: row.event.name,
        slug: row.event.slug,
        timezone: row.event.timezone,
        endsAt: row.event.endsAt,
      },
      hasOwnRegistration: row.event.registrations.length > 0,
      clubOrganizationId: row.event.clubRegistrations[0]?.organizationId ?? null,
    })),
    now,
  );
}
