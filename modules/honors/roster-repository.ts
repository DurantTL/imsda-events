import "server-only";

import { getPrisma } from "@/lib/prisma";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  dietaryFieldPattern,
  type RosterAttendee,
  type RosterEnrollment,
  type RosterOffering,
  type RosterSession,
} from "@/modules/honors/roster-domain";

type Snapshot = { firstName?: string; lastName?: string; ageOnEventDate?: number | null; clubRosterMemberId?: string };

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
  options: { includeDietary: boolean; organizationId?: string },
) {
  const prisma = getPrisma();
  const [event, sessions, offerings, clubRegistrations] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true, location: true } }),
    prisma.honorSession.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, sortOrder: true } }),
    prisma.honorOffering.findMany({
      where: { eventId },
      select: {
        id: true, span: true, sessionId: true, capacity: true, teacherName: true, location: true, isActive: true,
        honor: { select: { name: true, code: true } },
      },
    }),
    prisma.clubEventRegistration.findMany({
      where: {
        eventId,
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
        registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
      },
      select: {
        organizationId: true,
        organization: { select: { name: true } },
        registration: {
          select: {
            publicFormSubmission: { select: { formVersion: { select: { definition: true } } } },
            attendees: {
              orderBy: { position: "asc" },
              select: {
                id: true,
                profileSnapshot: true,
                formResponses: options.includeDietary,
                checkIns: { where: { undoneAt: null }, select: { id: true }, take: 1 },
              },
            },
          },
        },
      },
    }),
  ]);
  if (!event) return null;

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
        clubName: club.organization.name,
        ageOnEventDate: typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null,
        attendeeType: snapshot.clubRosterMemberId ? typeByMember.get(snapshot.clubRosterMemberId) ?? null : null,
        checkedIn: attendee.checkIns.length > 0,
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
      honorName: offering.honor.name,
      honorCode: offering.honor.code,
      span: offering.span,
      sessionId: offering.sessionId,
      capacity: offering.capacity,
      teacherName: offering.teacherName,
      location: offering.location,
      isActive: offering.isActive,
    })),
    enrollments,
    attendees,
    clubs: [...new Map(clubRegistrations.map((club) => [club.organizationId, { id: club.organizationId, name: club.organization.name }])).values()]
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export type HonorRosterData = NonNullable<Awaited<ReturnType<typeof getHonorRosterData>>>;
