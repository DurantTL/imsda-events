import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  matchingRegistrationIdsForVerifiedEmail,
} from "@/modules/attendee-accounts/registrations-repository";
import { publicAttendeeName } from "@/modules/public-access/domain";

export type AttendeeRetreatHub = NonNullable<
  Awaited<ReturnType<typeof getAttendeeRetreatHub>>
>;

export async function getAttendeeRetreatHub(
  verifiedEmail: string,
  eventSlug: string,
) {
  const registrationIds = await matchingRegistrationIdsForVerifiedEmail(
    verifiedEmail,
  );
  if (registrationIds.length === 0) return null;
  const event = await getPrisma().event.findUnique({
    where: { slug: eventSlug },
    select: {
      id: true,
      slug: true,
      name: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      location: true,
      supportContact: true,
      announcements: {
        where: { status: "PUBLISHED" },
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          title: true,
          body: true,
          priority: true,
          publishedAt: true,
        },
      },
      contentSections: {
        where: { isPublished: true },
        orderBy: { position: "asc" },
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          links: {
            orderBy: { position: "asc" },
            select: {
              label: true,
              description: true,
              url: true,
              assetId: true,
            },
          },
        },
      },
      registrations: {
        where: {
          id: { in: registrationIds },
          status: { in: ["SUBMITTED", "CONFIRMED"] },
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          confirmationCode: true,
          status: true,
          attendees: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            select: {
              id: true,
              profileSnapshot: true,
              person: { select: { firstName: true, lastName: true } },
              checkIns: {
                where: { undoneAt: null },
                orderBy: { checkedInAt: "desc" },
                take: 1,
                select: { checkedInAt: true },
              },
            },
          },
        },
      },
    },
  });
  if (!event || event.registrations.length === 0) return null;

  const attendeeIds = event.registrations.flatMap((registration) => (
    registration.attendees.map((attendee) => attendee.id)
  ));
  const runs = attendeeIds.length > 0
    ? await getPrisma().programAssignmentRun.findMany({
        where: {
          eventId: event.id,
          assignments: {
            some: { attendeeIdSnapshot: { in: attendeeIds } },
          },
        },
        orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          fieldId: true,
          fieldLabelSnapshot: true,
          appliedAt: true,
          assignments: {
            where: { attendeeIdSnapshot: { in: attendeeIds } },
            orderBy: { stableOrder: "asc" },
            select: {
              attendeeIdSnapshot: true,
              firstNameSnapshot: true,
              lastNameSnapshot: true,
              optionValue: true,
              preferenceRank: true,
              outcome: true,
            },
          },
        },
      })
    : [];
  const latestFieldIds = new Set<string>();
  const currentRuns = runs.filter((run) => {
    if (latestFieldIds.has(run.fieldId)) return false;
    latestFieldIds.add(run.fieldId);
    return true;
  });

  return {
    event: {
      slug: event.slug,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
      supportContact: event.supportContact,
    },
    announcements: event.announcements.map((announcement) => ({
      ...announcement,
      publishedAt: announcement.publishedAt?.toISOString() ?? null,
    })),
    contentSections: event.contentSections,
    registrations: event.registrations.map((registration) => ({
      id: registration.id,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      attendees: registration.attendees.map((attendee) => ({
        id: attendee.id,
        name: publicAttendeeName(attendee.profileSnapshot, attendee.person),
        checkedInAt: attendee.checkIns[0]?.checkedInAt.toISOString() ?? null,
      })),
    })),
    assignmentRuns: currentRuns.map((run) => ({
      id: run.id,
      fieldLabel: run.fieldLabelSnapshot,
      appliedAt: run.appliedAt.toISOString(),
      assignments: run.assignments.map((assignment) => ({
        attendeeId: assignment.attendeeIdSnapshot,
        attendeeName: `${assignment.firstNameSnapshot} ${assignment.lastNameSnapshot}`.trim(),
        option: assignment.optionValue,
        preferenceRank: assignment.preferenceRank,
        outcome: assignment.outcome,
      })),
    })),
  };
}
