import "server-only";

import { getPrisma } from "@/lib/prisma";
import { clubsComplianceReminderCounts } from "@/modules/background-checks/repository";
import {
  registrationStatusFor,
  summarizeClub,
  type AreaClubSummary,
  type AreaEventClubRow,
} from "@/modules/club-reports/area-summary-domain";
import { directorGrantIsActive } from "@/modules/organizations/director-grants-domain";

/**
 * Every active club's report summary for a club year: read-only, counts and
 * points only. Background checks are the same counts-only reminder figures a
 * coordinator already sees on a club (#479), never a name or note. Director
 * names are the club's current Director role holders.
 */
export async function getAreaClubsSummary(
  clubYear: string,
  now = new Date(),
  options: { backgroundChecks?: boolean } = {},
): Promise<AreaClubSummary[]> {
  const withChecks = options.backgroundChecks !== false;
  const prisma = getPrisma();
  const clubs = await prisma.organization.findMany({
    where: { type: "CLUB", isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, parentOrganization: { select: { name: true } } },
  });
  const clubIds = clubs.map((club) => club.id);
  const [reports, standings, rosterGroups, grants] = await Promise.all([
    prisma.clubMonthlyReport.findMany({
      where: { clubYear, organizationId: { in: clubIds } },
      select: { organizationId: true, reportMonth: true, status: true, totalPoints: true, onTimePoints: true },
    }),
    prisma.clubYearStanding.findMany({ where: { clubYear }, select: { organizationId: true, registrationOnTime: true } }),
    prisma.clubRosterMember.groupBy({
      by: ["organizationId"],
      where: { clubYear, status: "ACTIVE", organizationId: { in: clubIds } },
      _count: { _all: true },
    }),
    prisma.clubDirectorGrant.findMany({
      where: {
        organizationId: { in: clubIds },
        role: "DIRECTOR",
        revokedAt: null,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { attendeeAccount: { displayName: "asc" } },
      select: { organizationId: true, effectiveFrom: true, effectiveTo: true, revokedAt: true, attendeeAccount: { select: { displayName: true } } },
    }),
  ]);
  // Counts only, in one batched query; skipped by callers that don't show them.
  const checks = withChecks ? await clubsComplianceReminderCounts(clubIds, clubYear) : new Map();
  const onTime = new Map(standings.map((standing) => [standing.organizationId, standing.registrationOnTime]));
  const roster = new Map(rosterGroups.map((group) => [group.organizationId, group._count._all]));
  return clubs.map((club) =>
    summarizeClub({
      id: club.id,
      name: club.name,
      church: club.parentOrganization?.name ?? "",
      directors: grants
        .filter((grant) => grant.organizationId === club.id && directorGrantIsActive(grant, now))
        .map((grant) => grant.attendeeAccount.displayName),
      rosterSize: roster.get(club.id) ?? 0,
      registrationOnTime: onTime.get(club.id) ?? false,
      backgroundChecks: checks.get(club.id) ?? { missing: 0, notInCompliance: 0, expiringSoon: 0 },
      reports: reports.filter((report) => report.organizationId === club.id),
    }, clubYear, now));
}

export type AreaClubEvent = {
  id: string;
  name: string;
  startsAt: string;
  clubs: AreaEventClubRow[];
};

/** Club-audience events that fall inside the club year (Sept 1 to before the next Sept 1), with each active club's registration status and headcount. */
export async function listAreaClubEvents(clubYear: string): Promise<AreaClubEvent[]> {
  const prisma = getPrisma();
  const yearStart = new Date(`${clubYear.slice(0, 4)}-09-01T00:00:00Z`);
  const yearEnd = new Date(`${Number(clubYear.slice(0, 4)) + 1}-09-01T00:00:00Z`);
  const [clubs, events] = await Promise.all([
    prisma.organization.findMany({ where: { type: "CLUB", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.event.findMany({
      where: { isPublished: true, audience: "CLUB", endsAt: { gte: yearStart }, startsAt: { lt: yearEnd } },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        name: true,
        startsAt: true,
        clubRegistrations: {
          select: { organizationId: true, registration: { select: { status: true, _count: { select: { attendees: true } } } } },
        },
        clubRegistrationDrafts: { select: { organizationId: true } },
      },
    }),
  ]);
  return events.map((event) => {
    // A club may have several registrations (#809, teams): it shows as registered when any is, with the people across the
    // registered ones; otherwise it shows the first one's status, exactly as a club with one registration always did.
    const registrations = new Map<string, { status: (typeof event.clubRegistrations)[number]["registration"]["status"]; _count: { attendees: number } }>();
    const byClub = Map.groupBy(event.clubRegistrations, (entry) => entry.organizationId);
    for (const [organizationId, entries] of byClub) {
      const registered = entries.filter((entry) => registrationStatusFor(entry.registration.status) === "REGISTERED");
      const counted = registered.length > 0 ? registered : entries.slice(0, 1);
      registrations.set(organizationId, {
        status: counted[0]!.registration.status,
        _count: { attendees: counted.reduce((sum, entry) => sum + entry.registration._count.attendees, 0) },
      });
    }
    const drafts = new Set(event.clubRegistrationDrafts.map((draft) => draft.organizationId));
    return {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      clubs: clubs.map((club) => {
        const registration = registrations.get(club.id);
        const status = registration ? registrationStatusFor(registration.status) : drafts.has(club.id) ? "DRAFT" : "NOT_REGISTERED";
        return {
          organizationId: club.id,
          name: club.name,
          status,
          headcount: registration ? registration._count.attendees : null,
        } satisfies AreaEventClubRow;
      }),
    };
  });
}
