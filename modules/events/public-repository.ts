import "server-only";

import { cache } from "react";
import { getPrisma } from "@/lib/prisma";
import {
  buildPublicEventAnnouncementFeed,
  describePublicEventLifecycle,
  formatPublicEventSchedule,
  publicEventWebsiteLinks,
  summarizePublicRegistrationForm,
} from "@/modules/events/public-domain";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

async function loadPublicEventLanding(
  eventSlug: string,
  now = new Date(),
) {
  const prisma = getPrisma();
  const event = await prisma.event.findFirst({
    where: { slug: eventSlug, isPublished: true },
    select: {
      id: true,
      slug: true,
      name: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      location: true,
      capacity: true,
      publicInfoUrl: true,
      supportContact: true,
      isPublished: true,
      registrationOpensOn: true,
      registrationClosesOn: true,
      waitlistEnabled: true,
      announcements: {
        where: {
          status: "PUBLISHED",
          publishedAt: { lte: now },
          audience: { equals: { type: "ALL_ATTENDEES" } },
        },
        orderBy: [
          { priority: "desc" },
          { publishedAt: "desc" },
          { createdAt: "desc" },
          { id: "asc" },
        ],
        select: {
          title: true,
          body: true,
          audience: true,
          placement: true,
          status: true,
          priority: true,
          publishedAt: true,
        },
      },
      registrationForms: {
        where: {
          versions: { some: { status: "PUBLISHED" } },
        },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          slug: true,
          versions: {
            where: { status: "PUBLISHED" },
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: {
              id: true,
              versionNumber: true,
              definition: true,
            },
          },
        },
      },
    },
  });
  if (!event) return null;

  const occupiedSpots = await prisma.registrationAttendee.count({
    where: {
      eventId: event.id,
      registration: { status: { in: [...activeRegistrationStatuses] } },
    },
  });
  const lifecycle = describePublicEventLifecycle(event, occupiedSpots, now);
  const schedule = formatPublicEventSchedule(
    event.startsAt,
    event.endsAt,
    event.timezone,
  );
  const links = publicEventWebsiteLinks(event.slug, event.publicInfoUrl);
  const announcements = buildPublicEventAnnouncementFeed(
    event.announcements,
    event.timezone,
    now,
  );

  const forms = event.registrationForms.flatMap((form) => {
    const version = form.versions[0];
    if (!version) return [];
    const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) {
      console.error(
        `Published registration form ${form.id} has an invalid definition and was omitted from the public event page.`,
      );
      return [];
    }
    const summary = summarizePublicRegistrationForm(parsed.data);
    return [{
      id: form.id,
      slug: form.slug,
      versionId: version.id,
      versionNumber: version.versionNumber,
      name: form.name,
      ...summary,
      href: `/register/${event.slug}/${form.slug}`,
    }];
  });

  return {
    event: {
      slug: event.slug,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
      capacity: event.capacity,
      supportContact: event.supportContact,
      dateLabel: schedule.dateLabel,
      timeLabel: schedule.timeLabel,
    },
    lifecycle,
    announcements,
    forms,
    links,
  };
}

export type PublicEventLanding = NonNullable<
  Awaited<ReturnType<typeof loadPublicEventLanding>>
>;

export const getPublicEventLanding = cache(loadPublicEventLanding);

export async function listPublicEventSitemapEntries() {
  return getPrisma().event.findMany({
    where: {
      isPublished: true,
      registrationForms: {
        some: { versions: { some: { status: "PUBLISHED" } } },
      },
    },
    orderBy: { startsAt: "asc" },
    select: {
      slug: true,
      updatedAt: true,
    },
  });
}
