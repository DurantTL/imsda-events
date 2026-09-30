import "server-only";

import { getPrisma } from "@/lib/prisma";
import { areaGrantActive } from "@/modules/organizations/area-coordinators";
import {
  clubsNeedingAttention,
  registrationWindow,
  type RegistrationWindow,
} from "@/modules/club-reports/area-card-domain";
import { registrationStatusFor } from "@/modules/club-reports/area-summary-domain";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";
import { clubYearFor } from "@/modules/club-rosters/domain";

export type AreaCardEvent = {
  eventId: string;
  eventName: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationName: string | null;
  registration: RegistrationWindow;
  clubsRegistered: number;
  headcount: number;
};

export type AreaCoordinatorCard = {
  /** Locations this person coordinates, at events that haven't ended. */
  coordinatedLocations: AreaCardEvent[];
  /** Every upcoming club event, because coordinators help at each other's events. */
  clubEvents: AreaCardEvent[];
  needingAttention: ReturnType<typeof clubsNeedingAttention> & { clubYear: string };
};

/**
 * Read-only data for the home card. Returns null unless the account holds an
 * active Area Coordinator grant, so a revoked or expired coordinator sees no
 * card. Clubs and headcounts only, like the coordinator Clubs section.
 */
export async function getAreaCoordinatorCard(accountId: string, now = new Date()): Promise<AreaCoordinatorCard | null> {
  const prisma = getPrisma();
  const grant = await prisma.areaCoordinatorGrant.findUnique({
    where: { attendeeAccountId: accountId },
    select: { revokedAt: true, expiresAt: true, attendeeAccount: { select: { disabledAt: true } } },
  });
  if (!grant || grant.attendeeAccount.disabledAt || !areaGrantActive(grant, now)) return null;

  const clubYear = clubYearFor(now);
  const [locations, clubEvents, summary] = await Promise.all([
    prisma.eventLocation.findMany({
      where: { coordinatorAccountId: accountId, isActive: true, event: { endsAt: { gte: now } } },
      orderBy: [{ event: { startsAt: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        registrationClosesOn: true,
        event: { select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true, registrationOpensOn: true, registrationClosesOn: true } },
      },
    }),
    prisma.event.findMany({
      where: { isPublished: true, audience: "CLUB", endsAt: { gte: now } },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        name: true,
        startsAt: true,
        endsAt: true,
        timezone: true,
        registrationOpensOn: true,
        registrationClosesOn: true,
        clubRegistrations: { select: { registration: { select: { status: true, _count: { select: { attendees: true } } } } } },
      },
    }),
    getAreaClubsSummary(clubYear, now),
  ]);

  const locationIds = locations.map((location) => location.id);
  const locationRegistrations = locationIds.length === 0 ? [] : await prisma.registration.findMany({
    where: { locationId: { in: locationIds }, status: { in: ["SUBMITTED", "CONFIRMED"] }, clubRegistration: { isNot: null } },
    select: { locationId: true, _count: { select: { attendees: true } } },
  });

  return {
    coordinatedLocations: locations.map((location) => {
      const here = locationRegistrations.filter((registration) => registration.locationId === location.id);
      return {
        eventId: location.event.id,
        eventName: location.event.name,
        startsAt: location.event.startsAt.toISOString(),
        endsAt: location.event.endsAt.toISOString(),
        timezone: location.event.timezone,
        locationName: location.name,
        registration: registrationWindow(location.event.registrationOpensOn, location.registrationClosesOn ?? location.event.registrationClosesOn, now),
        clubsRegistered: here.length,
        headcount: here.reduce((sum, registration) => sum + registration._count.attendees, 0),
      };
    }),
    clubEvents: clubEvents.map((event) => {
      const registered = event.clubRegistrations
        .map((entry) => entry.registration)
        .filter((registration) => registrationStatusFor(registration.status) === "REGISTERED");
      return {
        eventId: event.id,
        eventName: event.name,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
        timezone: event.timezone,
        locationName: null,
        registration: registrationWindow(event.registrationOpensOn, event.registrationClosesOn, now),
        clubsRegistered: registered.length,
        headcount: registered.reduce((sum, registration) => sum + registration._count.attendees, 0),
      };
    }),
    needingAttention: { ...clubsNeedingAttention(summary), clubYear },
  };
}
