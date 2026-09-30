import "server-only";

import { cache } from "react";
import { getPrisma } from "@/lib/prisma";
import { logWarn } from "@/lib/logger";
import { formatPublicEventSchedule } from "@/modules/events/public-domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  buildEventInfoCards,
  type EventInfoCards,
  type InfoCardForm,
} from "@/modules/event-info-cards/domain";

/**
 * The auto-built info cards of a published CLUB event (#651), or null for any
 * other event so its public page stays exactly as it was. Read-only and public:
 * it selects only what the cards show (no rosters, no enrollment counts).
 */
async function loadAutoEventInfoCards(eventSlug: string): Promise<EventInfoCards | null> {
  const prisma = getPrisma();
  const event = await prisma.event.findFirst({
    where: { slug: eventSlug, isPublished: true, audience: "CLUB" },
    select: {
      id: true,
      name: true,
      location: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      tagline: true,
      subtitle: true,
      helpEmail: true,
      audience: true,
      billingMode: true,
      registrationClosesOn: true,
      locations: {
        select: {
          id: true,
          isActive: true,
          name: true,
          address: true,
          firstDay: true,
          lastDay: true,
          registrationClosesOn: true,
          sortOrder: true,
        },
      },
      honorSessions: {
        select: { id: true, name: true, locationId: true, sortOrder: true },
      },
      honorOfferings: {
        where: { isActive: true },
        select: {
          id: true,
          span: true,
          sessionId: true,
          locationId: true,
          capacity: true,
          minimumAge: true,
          perClubLimit: true,
          teacherName: true,
          additionalCostCents: true,
          requirementNote: true,
          honor: { select: { name: true } },
        },
      },
      registrationForms: {
        where: { versions: { some: { status: "PUBLISHED" } } },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          versions: {
            where: { status: "PUBLISHED" },
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: { definition: true },
          },
        },
      },
    },
  });
  if (!event) return null;

  const forms = event.registrationForms.flatMap((form): InfoCardForm[] => {
    const version = form.versions[0];
    if (!version) return [];
    const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) {
      logWarn("A published registration form has an invalid definition and was left out of the event info cards.", { formId: form.id });
      return [];
    }
    return [{ title: form.name, definition: parsed.data }];
  });

  return buildEventInfoCards({
    event: {
      name: event.name,
      location: event.location,
      dateLabel: formatPublicEventSchedule(event.startsAt, event.endsAt, event.timezone).dateLabel,
      tagline: event.tagline,
      subtitle: event.subtitle,
      helpEmail: event.helpEmail,
      audience: event.audience,
      billingMode: event.billingMode,
      registrationClosesOn: event.registrationClosesOn,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
    },
    locations: event.locations.filter((location) => location.isActive),
    inactiveLocationIds: event.locations.filter((location) => !location.isActive).map((location) => location.id),
    sessions: event.honorSessions,
    offerings: event.honorOfferings.map((offering) => ({
      id: offering.id,
      honorName: offering.honor.name,
      teacherName: offering.teacherName,
      capacity: offering.capacity,
      minimumAge: offering.minimumAge,
      perClubLimit: offering.perClubLimit,
      additionalCostCents: offering.additionalCostCents,
      requirementNote: offering.requirementNote,
      span: offering.span,
      sessionId: offering.sessionId,
      locationId: offering.locationId,
    })),
    forms,
  });
}

export const getAutoEventInfoCards = cache(loadAutoEventInfoCards);
