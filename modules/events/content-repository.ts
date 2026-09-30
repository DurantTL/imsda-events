import "server-only";

import { Prisma } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import {
  parseEventContentItems,
  type EventContentInput,
  type EventContentItem,
  type EventContentKind,
  type EventContentPlacement,
  type EventContentTone,
} from "@/modules/events/content-schemas";

/** Thrown when a content save cannot be honored as written. */
export class EventContentError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_IN_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "EventContentError";
  }
}

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
  kind: EventContentKind;
  title: string;
  body: string;
  /** NOTICE cards only; null for every other kind. */
  tone: EventContentTone | null;
  placement: EventContentPlacement;
  /** STEPS and CHECKLIST entries; empty for every other kind. */
  items: EventContentItem[];
  isPublished: boolean;
  links: EventContentLinkRecord[];
};

const sectionSelect = {
  id: true,
  kind: true,
  title: true,
  body: true,
  tone: true,
  placement: true,
  items: true,
  isPublished: true,
  links: {
    orderBy: { position: "asc" as const },
    select: { label: true, description: true, url: true, assetId: true },
  },
} as const;

type StoredSection = Omit<EventContentSectionRecord, "items"> & { items: unknown };

function toRecord(section: StoredSection): EventContentSectionRecord {
  return { ...section, items: parseEventContentItems(section.items) };
}

/** Every section, published or not. For staff. */
export async function listEventContentSections(
  eventId: string,
): Promise<EventContentSectionRecord[]> {
  const rows = await getPrisma().eventContentSection.findMany({
    where: { eventId },
    orderBy: { position: "asc" },
    select: sectionSelect,
  });
  return rows.map(toRecord);
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
  const rows = await getPrisma().eventContentSection.findMany({
    where: { eventId, isPublished: true },
    orderBy: { position: "asc" },
    select: sectionSelect,
  });
  return rows.map(toRecord);
}

/**
 * Published info cards placed at the top of the registration form, looked up
 * by the event's public slug. Same rule as the public page: drafts are
 * filtered in the query.
 */
export async function listPublishedRegistrationInfoCards(
  eventSlug: string,
): Promise<EventContentSectionRecord[]> {
  const rows = await getPrisma().eventContentSection.findMany({
    where: {
      event: { slug: eventSlug, isPublished: true },
      isPublished: true,
      kind: { in: ["NOTICE", "STEPS", "CHECKLIST"] },
      placement: { in: ["REGISTRATION_FORM", "BOTH"] },
    },
    orderBy: { position: "asc" },
    select: sectionSelect,
  });
  return rows.map(toRecord);
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
  const linkedAssetIds = [...new Set(
    input.sections.flatMap((section) => (
      section.kind === "RESOURCE_LINKS" || section.kind === "NOTICE"
        ? section.links.flatMap((link) => (link.assetId ? [link.assetId] : []))
        : []
    )),
  )];
  try {
    await prisma.$transaction(async (tx) => {
      // Every linked file must belong to this event. Checked inside the same
      // transaction as the write, against the live table rather than a value
      // read earlier, so a file moved or removed between page load and save
      // cannot slip through. Nothing is written until this passes.
      if (linkedAssetIds.length > 0) {
        const owned = await tx.eventAsset.findMany({
          where: { id: { in: linkedAssetIds }, eventId },
          select: { id: true },
        });
        if (owned.length !== linkedAssetIds.length) {
          throw new EventContentError(
            "ASSET_NOT_IN_EVENT",
            "One of the linked files does not belong to this event. Reload and try again.",
          );
        }
      }

      // Links go with their section: the foreign key cascades on delete.
      await tx.eventContentSection.deleteMany({ where: { eventId } });
      for (const [position, section] of input.sections.entries()) {
        await tx.eventContentSection.create({
          data: {
            eventId,
            kind: section.kind,
            title: section.title,
            body: section.kind === "RICH_TEXT" || section.kind === "NOTICE" ? section.body : "",
            tone: section.kind === "NOTICE" ? section.tone ?? "INFO" : null,
            placement: section.placement,
            items: section.kind === "STEPS" || section.kind === "CHECKLIST"
              ? section.items.map((item) => ({
                title: item.title,
                text: section.kind === "STEPS" ? item.text : "",
              }))
              : [],
            isPublished: section.isPublished,
            position,
            links: section.kind === "RESOURCE_LINKS" || section.kind === "NOTICE"
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
  } catch (error) {
    // A linked file deleted between the ownership check and the link insert
    // trips the link's foreign key. Nothing was written; say so the same way.
    // Only when a linked file really is gone: a foreign-key failure on the
    // event or the audit actor is a different fault and keeps its 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2003"
      && linkedAssetIds.length > 0
      && await prisma.eventAsset.count({ where: { id: { in: linkedAssetIds }, eventId } }) < linkedAssetIds.length
    ) {
      throw new EventContentError(
        "ASSET_NOT_IN_EVENT",
        "One of the linked files does not belong to this event. Reload and try again.",
      );
    }
    throw error;
  }
  return listEventContentSections(eventId);
}
