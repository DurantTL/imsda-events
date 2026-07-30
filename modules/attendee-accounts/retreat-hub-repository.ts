import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  matchingRegistrationIdsForVerifiedEmail,
} from "@/modules/attendee-accounts/registrations-repository";
import { listEventsForUser } from "@/modules/events/repository";
import { publicAttendeeName } from "@/modules/public-access/domain";

export type AttendeeRetreatHub = NonNullable<
  Awaited<ReturnType<typeof getAttendeeRetreatHub>>
>;

const retreatHubEventSelect = {
  id: true,
  slug: true,
  name: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  location: true,
  supportContact: true,
  announcements: {
    where: { status: "PUBLISHED" as const },
    orderBy: [
      { publishedAt: "desc" as const },
      { updatedAt: "desc" as const },
    ],
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
    orderBy: { position: "asc" as const },
    select: {
      id: true,
      kind: true,
      title: true,
      body: true,
      links: {
        orderBy: { position: "asc" as const },
        select: {
          label: true,
          description: true,
          url: true,
          assetId: true,
        },
      },
    },
  },
};

function retreatHubEventRecord(event: {
  slug: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  supportContact: string | null;
}) {
  return {
    slug: event.slug,
    name: event.name,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    timezone: event.timezone,
    location: event.location,
    supportContact: event.supportContact,
  };
}

function retreatHubAnnouncementRecords(event: {
  announcements: Array<{
    id: string;
    title: string;
    body: string;
    priority: "NORMAL" | "IMPORTANT" | "URGENT";
    publishedAt: Date | null;
  }>;
}) {
  return event.announcements.map((announcement) => ({
    ...announcement,
    publishedAt: announcement.publishedAt?.toISOString() ?? null,
  }));
}

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
      ...retreatHubEventSelect,
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
    event: retreatHubEventRecord(event),
    announcements: retreatHubAnnouncementRecords(event),
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

/**
 * Read-only staff preview of the attendee-facing retreat hub.
 *
 * The accessible-event lookup is the authorization boundary. It deliberately
 * returns no registrations, passes, or assignments: staff can inspect the
 * shared attendee experience without impersonating a registrant or receiving
 * access through somebody else's verified email.
 */
export async function getStaffRetreatHubPreview(
  user: {
    id: string;
    globalRole?: "SYSTEM_ADMIN" | null;
  },
  eventSlug: string,
) {
  const accessibleEvents = await listEventsForUser(
    user.id,
    user.globalRole === "SYSTEM_ADMIN",
  );
  const accessibleEvent = accessibleEvents.find(
    (event) => event.slug === eventSlug,
  );
  if (!accessibleEvent) return null;

  const event = await getPrisma().event.findUnique({
    where: { id: accessibleEvent.id },
    select: retreatHubEventSelect,
  });
  if (!event) return null;

  return {
    eventId: event.id,
    hub: {
      event: retreatHubEventRecord(event),
      announcements: retreatHubAnnouncementRecords(event),
      contentSections: event.contentSections,
      registrations: [],
      assignmentRuns: [],
    } satisfies AttendeeRetreatHub,
  };
}
