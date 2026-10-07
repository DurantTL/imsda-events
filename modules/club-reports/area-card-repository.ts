import "server-only";

import { getPrisma } from "@/lib/prisma";
import { clubsComplianceReminderCounts } from "@/modules/background-checks/repository";
import {
  clubsNeedingAttention,
  registrationWindow,
  type RegistrationWindow,
} from "@/modules/club-reports/area-card-domain";
import { registrationStatusFor } from "@/modules/club-reports/area-summary-domain";
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
  /** Locations this person coordinates, at published club events that haven't ended. */
  coordinatedLocations: AreaCardEvent[];
  /** Every upcoming club event, because coordinators help at each other's events. */
  clubEvents: AreaCardEvent[];
  needingAttention: ReturnType<typeof clubsNeedingAttention> & { clubYear: string };
};

/** Counts of active clubs needing attention, without building the full per-club summary. */
async function loadClubsNeedingAttention(clubYear: string, now: Date) {
  const prisma = getPrisma();
  const clubs = await prisma.organization.findMany({ where: { type: "CLUB", isActive: true }, select: { id: true } });
  const clubIds = clubs.map((club) => club.id);
  const [reports, checks] = await Promise.all([
    prisma.clubMonthlyReport.findMany({
      where: { clubYear, organizationId: { in: clubIds } },
      select: { organizationId: true, reportMonth: true, status: true, totalPoints: true, onTimePoints: true },
    }),
    clubsComplianceReminderCounts(clubIds, clubYear),
  ]);
  return { ...clubsNeedingAttention({ clubIds, clubYear, now, reports, checks }), clubYear };
}

/**
 * Read-only data for the home card. The caller MUST resolve the viewer with
 * `currentAreaCoordinator()` (active grant, second sign-in step, and their own
 * attendee session, never staff) and pass that account: this loader does no
 * access check of its own. Clubs and headcounts only, like the coordinator
 * Clubs section; only active clubs are counted.
 */
export async function getAreaCoordinatorCard(account: { id: string }, now = new Date()): Promise<AreaCoordinatorCard> {
  const prisma = getPrisma();
  const accountId = account.id;
  const clubYear = clubYearFor(now);
  const [locations, clubEvents, needingAttention] = await Promise.all([
    prisma.eventLocation.findMany({
      where: { coordinatorAccountId: accountId, isActive: true, event: { isPublished: true, audience: "CLUB", endsAt: { gte: now } } },
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
        clubRegistrations: {
          where: { organization: { isActive: true } },
          select: { organizationId: true, registration: { select: { status: true, _count: { select: { attendees: true } } } } },
        },
      },
    }),
    loadClubsNeedingAttention(clubYear, now),
  ]);

  const locationIds = locations.map((location) => location.id);
  const locationRegistrations = locationIds.length === 0 ? [] : await prisma.registration.findMany({
    where: { locationId: { in: locationIds }, status: { in: ["SUBMITTED", "CONFIRMED"] }, clubRegistration: { organization: { isActive: true } } },
    select: { locationId: true, clubRegistration: { select: { organizationId: true } }, _count: { select: { attendees: true } } },
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
        // Clubs, not registrations: a club that registers several teams (#809) is still one club.
        clubsRegistered: new Set(here.map((registration) => registration.clubRegistration?.organizationId)).size,
        headcount: here.reduce((sum, registration) => sum + registration._count.attendees, 0),
      };
    }),
    clubEvents: clubEvents.map((event) => {
      const registeredEntries = event.clubRegistrations
        .filter((entry) => registrationStatusFor(entry.registration.status) === "REGISTERED");
      const registered = registeredEntries.map((entry) => entry.registration);
      return {
        eventId: event.id,
        eventName: event.name,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
        timezone: event.timezone,
        locationName: null,
        registration: registrationWindow(event.registrationOpensOn, event.registrationClosesOn, now),
        // Clubs, not registrations: a club that registers several teams (#809) is still one club.
        clubsRegistered: new Set(registeredEntries.map((entry) => entry.organizationId)).size,
        headcount: registered.reduce((sum, registration) => sum + registration._count.attendees, 0),
      };
    }),
    needingAttention,
  };
}
