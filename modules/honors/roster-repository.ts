import "server-only";

import { getPrisma } from "@/lib/prisma";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { offeringHonorsSelect, summarizeOfferingHonors } from "@/modules/honors/offering-honors";
import {
  dietaryFieldPattern,
  type RosterAttendee,
  type RosterEnrollment,
  type RosterOffering,
  type RosterSession,
} from "@/modules/honors/roster-domain";

type Snapshot = { firstName?: string; lastName?: string; ageOnEventDate?: number | null; clubRosterMemberId?: string; temporaryAttendeeType?: "ADULT" | "YOUTH" };

/** The attendee fields on a form version that ask about food or allergies. */
function dietaryFieldKeys(definition: unknown) {
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  if (!parsed.success) return [];
  return parsed.data.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.scope === "ATTENDEE" && dietaryFieldPattern.test(`${field.label} ${field.key}`))
    .map((field) => field.key);
}

function dietaryAnswer(responses: unknown, keys: readonly string[]) {
  if (!responses || typeof responses !== "object") return null;
  const answers = keys
    .map((key) => (responses as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim().slice(0, 200));
  return answers.length ? answers.join("; ") : null;
}

/**
 * Everything the Honors Weekend rosters need for one site, from submitted
 * and confirmed club registrations only. `includeDietary` reads the dietary
 * answers, so callers pass it only for someone allowed to see sensitive data.
 * `organizationId` narrows the people to one club (a director's own).
 */
export async function getHonorRosterData(
  eventId: string,
  options: { includeDietary: boolean; organizationId?: string; /** Only this site's registrations and sessions (#589). */ locationId?: string },
) {
  const prisma = getPrisma();
  const registrationSelect = {
    locationId: true,
    location: { select: { name: true } },
    publicFormSubmission: { select: { formVersion: { select: { definition: true } } } },
    attendees: {
      orderBy: { position: "asc" as const },
      select: {
        id: true,
        profileSnapshot: true,
        formResponses: options.includeDietary,
        checkIns: { where: { undoneAt: null }, select: { id: true }, take: 1 },
      },
    },
  };
  const activeInScope = { status: { in: ["SUBMITTED" as const, "CONFIRMED" as const] }, ...(options.locationId ? { locationId: options.locationId } : {}) };
  const [event, allSessions, allOfferings, clubRegistrationRows, groupRegistrationRows, locations] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true, location: true } }),
    prisma.honorSession.findMany({
      where: { eventId, ...(options.locationId ? { OR: [{ locationId: options.locationId }, { locationId: null }] } : {}) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, locationId: true, sortOrder: true, createdAt: true, location: { select: { name: true } } },
    }),
    prisma.honorOffering.findMany({
      where: { eventId },
      select: {
        id: true, span: true, sessionId: true, locationId: true, site: { select: { name: true } },
        capacity: true, teacherName: true, location: true, isActive: true,
        honors: offeringHonorsSelect,
      },
    }),
    prisma.clubEventRegistration.findMany({
      where: {
        eventId,
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
        registration: activeInScope,
      },
      select: {
        organizationId: true,
        organization: { select: { name: true } },
        registration: { select: registrationSelect },
      },
    }),
    // "Group" registrations (#650) hold class seats too, so they are on the staff rosters. They are
    // never one club's: a director's own schedule (`organizationId`) never includes them.
    options.organizationId
      ? Promise.resolve([])
      : prisma.groupEventRegistration.findMany({
        where: { eventId, registration: activeInScope },
        select: {
          registrationId: true,
          billingPerson: { select: { firstName: true, lastName: true } },
          registration: { select: registrationSelect },
        },
      }),
    prisma.eventLocation.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, sortOrder: true } }),
  ]);
  if (!event) return null;
  // One entry per club or per group: its key, the name rosters print, and its registration.
  const clubRegistrations = [
    ...clubRegistrationRows.map((club) => ({ organizationId: club.organizationId, name: club.organization.name, registration: club.registration })),
    ...groupRegistrationRows.map((group) => ({
      organizationId: `group:${group.registrationId}`,
      name: `Group: ${`${group.billingPerson.firstName} ${group.billingPerson.lastName}`.trim() || "contact"}`,
      registration: group.registration,
    })),
  ];
  const sessions = allSessions.map((session) => ({ id: session.id, name: session.name, locationId: session.locationId, sortOrder: session.sortOrder, createdAt: session.createdAt }));
  const siteBySession = new Map(allSessions.map((session) => [session.id, session.location?.name ?? null]));
  // A class rides on its session's site; with a site filter, classes of other sites drop out.
  // With a site filter: single-session classes of other sites' sessions drop out (their session isn't loaded),
  // and so do all-sessions classes at another site. Classes with no site stay.
  const offerings = allOfferings.filter((offering) => (offering.sessionId
    ? siteBySession.has(offering.sessionId)
    : !options.locationId || !offering.locationId || offering.locationId === options.locationId));

  const memberIds = clubRegistrations.flatMap((club) => club.registration.attendees
    .map((attendee) => (attendee.profileSnapshot as Snapshot).clubRosterMemberId)
    .filter((id): id is string => Boolean(id)));
  const members = memberIds.length
    ? await prisma.clubRosterMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, attendeeType: true } })
    : [];
  const typeByMember = new Map(members.map((member) => [member.id, member.attendeeType]));

  const attendees: RosterAttendee[] = clubRegistrations.flatMap((club) => {
    const keys = options.includeDietary ? dietaryFieldKeys(club.registration.publicFormSubmission?.formVersion.definition) : [];
    return club.registration.attendees.map((attendee) => {
      const snapshot = attendee.profileSnapshot as Snapshot;
      return {
        id: attendee.id,
        firstName: snapshot.firstName ?? "",
        lastName: snapshot.lastName ?? "",
        clubId: club.organizationId,
        clubName: club.name,
        ageOnEventDate: typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null,
        attendeeType: snapshot.clubRosterMemberId ? typeByMember.get(snapshot.clubRosterMemberId) ?? null : snapshot.temporaryAttendeeType ?? null,
        checkedIn: attendee.checkIns.length > 0,
        locationId: club.registration.locationId,
        locationName: club.registration.location?.name ?? null,
        dietary: options.includeDietary ? dietaryAnswer((attendee as { formResponses?: unknown }).formResponses, keys) : null,
      };
    });
  });

  const attendeeIds = new Set(attendees.map((attendee) => attendee.id));
  const enrollmentRows = await prisma.honorEnrollment.findMany({
    where: { eventId, ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
    select: { offeringId: true, registrationAttendeeId: true, consumesSeat: true },
  });
  // Only people on an active registration appear; enrollments of a cancelled
  // registration are left out rather than shown with no name.
  const enrollments: RosterEnrollment[] = enrollmentRows
    .filter((row) => attendeeIds.has(row.registrationAttendeeId))
    .map((row) => ({ offeringId: row.offeringId, attendeeId: row.registrationAttendeeId, consumesSeat: row.consumesSeat }));

  return {
    event: {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
    },
    sessions: sessions satisfies RosterSession[],
    offerings: offerings.map((offering): RosterOffering => ({
      id: offering.id,
      // A class can teach several honors (#812); the roster lists everyone in the class under all of them.
      honorName: summarizeOfferingHonors(offering.honors).honorName,
      honorCode: summarizeOfferingHonors(offering.honors).honorCode,
      span: offering.span,
      sessionId: offering.sessionId,
      capacity: offering.capacity,
      teacherName: offering.teacherName,
      location: offering.location,
      isActive: offering.isActive,
      siteName: offering.sessionId ? siteBySession.get(offering.sessionId) ?? null : offering.site?.name ?? null,
    })),
    enrollments,
    attendees,
    /** Every site of the event (#589); empty for an event without locations. */
    locations,
    hasLocations: locations.length > 0,
    clubs: [...new Map(clubRegistrations.map((club) => [club.organizationId, { id: club.organizationId, name: club.name, siteName: club.registration.location?.name ?? null }])).values()]
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export type HonorRosterData = NonNullable<Awaited<ReturnType<typeof getHonorRosterData>>>;
