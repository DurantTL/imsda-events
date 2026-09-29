import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  selectAccountBannerAnnouncements,
  type AccountBannerAnnouncement,
} from "@/modules/communications/account-banner-domain";
import { matchingRegistrationIdsForVerifiedEmail } from "@/modules/attendee-accounts/registrations-repository";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { listDirectedClubs } from "@/modules/organizations/director-access";

/**
 * Published HOME_BANNER announcements for a signed-in account (#590). An event
 * is linked when the account has an active registration for it, or directs or
 * deputises a club with an active club registration for it. Nothing else is
 * ever read, so an unlinked event's announcements cannot reach the account.
 */
export async function listAccountBannerAnnouncements(
  account: { id: string; verifiedEmail: string },
  now = new Date(),
): Promise<AccountBannerAnnouncement[]> {
  const prisma = getPrisma();
  const [registrationIds, clubs] = await Promise.all([
    matchingRegistrationIdsForVerifiedEmail(account.verifiedEmail),
    listDirectedClubs(account.id, now),
  ]);
  const clubIds = clubs
    .filter((club) => club.role === "DIRECTOR" || club.role === "DEPUTY")
    .map((club) => club.organizationId);

  const [own, clubRegistrations] = await Promise.all([
    registrationIds.length > 0
      ? prisma.registration.findMany({
          where: { id: { in: registrationIds }, status: { in: [...activeRegistrationStatuses] } },
          select: { eventId: true },
        })
      : [],
    clubIds.length > 0
      ? prisma.clubEventRegistration.findMany({
          where: {
            organizationId: { in: clubIds },
            registration: { status: { in: [...activeRegistrationStatuses] } },
          },
          select: { eventId: true },
        })
      : [],
  ]);
  const eventIds = [...new Set([...own, ...clubRegistrations].map((row) => row.eventId))];
  if (eventIds.length === 0) return [];

  const rows = await prisma.announcement.findMany({
    where: {
      eventId: { in: eventIds },
      status: "PUBLISHED",
      placement: "HOME_BANNER",
      publishedAt: { lte: now },
    },
    select: {
      id: true,
      title: true,
      body: true,
      audience: true,
      placement: true,
      status: true,
      priority: true,
      publishedAt: true,
      pinnedAt: true,
      event: { select: { name: true, slug: true, timezone: true, endsAt: true } },
    },
  });
  return selectAccountBannerAnnouncements(rows, now);
}
