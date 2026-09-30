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
import { listPublishedEventContentSections } from "@/modules/events/content-repository";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { groupFormDefinition, groupFormProblem } from "@/modules/group-registrations/domain";
import { logWarn } from "@/lib/logger";

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
      audience: true,
      billingMode: true,
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
          createdAt: true,
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
    event.timezone
  );
  const links = publicEventWebsiteLinks(event.slug, event.publicInfoUrl);
  const announcements = buildPublicEventAnnouncementFeed(
    event.announcements,
    event.timezone,
    now
  );

  const forms = event.registrationForms.flatMap((form) => {
    const version = form.versions[0];
    if (!version) return [];
    const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) {
      logWarn(
        "A published registration form has an invalid definition and was omitted from the public event page.",
        { formId: form.id },
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

  // "Register as a group or individual" (#650): a club event also takes people who are not in a
  // club, when one of its published forms can be used for them. Labelled only "Group".
  // The club's own form (the first one created, as club registration picks it) is the one a group uses.
  const primaryForm = [...event.registrationForms].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  const primaryDefinition = registrationFormDefinitionSchema.safeParse(primaryForm?.versions[0]?.definition);
  const groupForm = event.audience === "CLUB" && event.billingMode === "DEFERRED_ORGANIZATION_INVOICE"
    && primaryDefinition.success && groupFormProblem(groupFormDefinition(primaryDefinition.data)) === null
    ? primaryForm
    : undefined;

  return {
    groupRegistration: groupForm
      ? { href: `/register/${event.slug}/group`, title: "Register as a group or individual", label: "Group" }
      : null,
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
    contentSections: await listPublishedEventContentSections(event.id),
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
