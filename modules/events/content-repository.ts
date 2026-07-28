import "server-only";

import { getPrisma } from "@/lib/prisma";
import type { EventContentInput } from "@/modules/events/content-schemas";

export type EventContentLinkRecord = {
  label: string;
  description: string;
  /** Set when the tile points elsewhere. Exactly one of these two is non-null. */
  url: string | null;
  /** Set when the tile points at a file uploaded here. */
  assetId: string | null;
};

export type EventContentSectionRecord = {
  id: string;
  kind: "RICH_TEXT" | "RESOURCE_LINKS";
  title: string;
  body: string;
  isPublished: boolean;
  links: EventContentLinkRecord[];
};

const sectionSelect = {
  id: true,
  kind: true,
  title: true,
  body: true,
  isPublished: true,
  links: {
    orderBy: { position: "asc" as const },
    select: { label: true, description: true, url: true, assetId: true },
  },
} as const;

/** Every section, published or not. For staff. */
export async function listEventContentSections(
  eventId: string,
): Promise<EventContentSectionRecord[]> {
  return getPrisma().eventContentSection.findMany({
    where: { eventId },
    orderBy: { position: "asc" },
    select: sectionSelect,
  });
}

/**
 * Only what a visitor may see.
 *
 * Filtered in the query rather than after loading. An unpublished section is a
 * draft about an event that has not happened — pulling it into the process and
 * trusting the renderer to drop it is one careless map away from publishing it.
 */
export async function listPublishedEventContentSections(
  eventId: string,
): Promise<EventContentSectionRecord[]> {
  return getPrisma().eventContentSection.findMany({
    where: { eventId, isPublished: true },
    orderBy: { position: "asc" },
    select: sectionSelect,
  });
}

/**
 * Replaces the page in one transaction.
 *
 * Whole-page rather than per-section: staff reorder and edit together, and a
 * partial save would leave the page in a state nobody chose. Sections are
 * rewritten rather than diffed — they carry no history worth preserving, and
 * matching them up by content would guess wrong the first time two sections
 * shared a heading.
 */
export async function replaceEventContent(
  eventId: string,
  input: EventContentInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    // Links go with their section: the foreign key cascades on delete.
    await tx.eventContentSection.deleteMany({ where: { eventId } });
    for (const [position, section] of input.sections.entries()) {
      await tx.eventContentSection.create({
        data: {
          eventId,
          kind: section.kind,
          title: section.title,
          body: section.kind === "RICH_TEXT" ? section.body : "",
          isPublished: section.isPublished,
          position,
          links: section.kind === "RESOURCE_LINKS"
            ? {
              create: section.links.map((link, linkPosition) => ({
                label: link.label,
                description: link.description,
                // The database carries an XOR check, so exactly one is stored.
                url: link.assetId ? null : link.url ?? null,
                assetId: link.assetId ?? null,
                position: linkPosition,
              })),
            }
            : undefined,
        },
      });
    }
    const publishedCount = input.sections.filter((section) => section.isPublished).length;
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "EVENT_CONTENT_REPLACED",
        entityType: "EventContentSection",
        entityId: eventId,
        correlationId: `event-content:${eventId}:${Date.now()}`,
        summary: `Saved ${input.sections.length} content section${input.sections.length === 1 ? "" : "s"}, ${publishedCount} published.`,
        metadata: {
          sectionCount: input.sections.length,
          publishedCount,
          titles: input.sections.map((section) => section.title),
        },
      },
    });
  });
  return listEventContentSections(eventId);
}
