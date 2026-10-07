import "server-only";

import { Prisma } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { customHtmlAssetIds, sanitizeCustomHtml } from "@/modules/events/content-html";
import {
  blockAssetIds,
  hasBlockData,
  parseBlockData,
  parseEventContentItems,
  registrationFormKinds,
  type EventContentInput,
  type EventContentItem,
  type EventContentKind,
  type EventContentPlacement,
  type EventContentTone,
} from "@/modules/events/content-schemas";

/** Thrown when a content save cannot be honored as written. */
export class EventContentError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_IN_EVENT" | "ASSET_NOT_AN_IMAGE" | "CUSTOM_HTML_FORBIDDEN",
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
  /** Per-kind block content (#816), as stored; `{}` for the older kinds. Parse with `parseBlockData`. */
  data: Record<string, unknown>;
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
  data: true,
  isPublished: true,
  links: {
    orderBy: { position: "asc" as const },
    select: { label: true, description: true, url: true, assetId: true },
  },
} as const;

type StoredSection = Omit<EventContentSectionRecord, "items" | "data"> & { items: unknown; data: unknown };

function toRecord(section: StoredSection): EventContentSectionRecord {
  const data = section.data && typeof section.data === "object" && !Array.isArray(section.data)
    ? (section.data as Record<string, unknown>)
    : {};
  return { ...section, items: parseEventContentItems(section.items), data };
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
      kind: { in: [...registrationFormKinds] },
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
  options: { isSystemAdmin?: boolean } = {},
) {
  const prisma = getPrisma();
  const isSystemAdmin = options.isSystemAdmin === true;

  // Everything that reaches the database is prepared here, once. Custom HTML
  // is sanitized here (and again whenever it renders); block data is re-parsed
  // so only the schema's own fields are stored, never extra keys a client sent.
  const prepared = input.sections.map((section) => {
    const body = section.kind === "CUSTOM_HTML" ? sanitizeCustomHtml(section.body) : section.body;
    const data = hasBlockData(section.kind) ? parseBlockData(section.kind, section.data) : null;
    const blockAssets = section.kind === "CUSTOM_HTML"
      ? customHtmlAssetIds(body)
      : blockAssetIds(section.kind, data);
    return { section, body, data, blockAssets };
  });

  const linkedAssetIds = [...new Set(
    input.sections.flatMap((section) => (
      section.kind === "RESOURCE_LINKS" || section.kind === "NOTICE"
        ? section.links.flatMap((link) => (link.assetId ? [link.assetId] : []))
        : []
    )),
  )];
  const imageAssetIds = [...new Set(prepared.flatMap((entry) => entry.blockAssets))];
  const assetsToCheck = [...new Set([...linkedAssetIds, ...imageAssetIds])];
  try {
    await prisma.$transaction(async (tx) => {
      // Custom HTML is system-administrator content. An event administrator's
      // save may carry the existing HTML blocks back unchanged (the editor
      // shows them read-only) but may not add one, edit one, or drop one.
      // Compared on the sanitized form, inside the transaction, against what
      // is stored now.
      if (!isSystemAdmin) {
        const stored = await tx.eventContentSection.findMany({
          where: { eventId, kind: "CUSTOM_HTML" },
          select: { title: true, body: true },
        });
        const fingerprint = (title: string, body: string) => `${title}\u0000${sanitizeCustomHtml(body)}`;
        const expected = stored.map((row) => fingerprint(row.title, row.body)).sort();
        const submitted = prepared
          .filter((entry) => entry.section.kind === "CUSTOM_HTML")
          .map((entry) => fingerprint(entry.section.title, entry.body))
          .sort();
        if (expected.length !== submitted.length || expected.some((value, index) => value !== submitted[index])) {
          throw new EventContentError(
            "CUSTOM_HTML_FORBIDDEN",
            "Only a system administrator can add, change, or remove custom HTML blocks.",
          );
        }
      }

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
      // A block's picture must be an image uploaded to this event.
      if (imageAssetIds.length > 0) {
        const images = await tx.eventAsset.findMany({
          where: { id: { in: imageAssetIds }, eventId },
          select: { id: true, contentType: true },
        });
        if (images.length !== imageAssetIds.length) {
          throw new EventContentError(
            "ASSET_NOT_IN_EVENT",
            "One of the images does not belong to this event. Reload and try again.",
          );
        }
        if (images.some((image) => !image.contentType.startsWith("image/"))) {
          throw new EventContentError(
            "ASSET_NOT_AN_IMAGE",
            "A block can only show an uploaded PNG, JPEG, or WebP image, not a PDF.",
          );
        }
      }

      // Links and image references go with their section: the foreign keys cascade on delete.
      await tx.eventContentSection.deleteMany({ where: { eventId } });
      for (const [position, entry] of prepared.entries()) {
        const { section, body, data, blockAssets } = entry;
        await tx.eventContentSection.create({
          data: {
            eventId,
            kind: section.kind,
            title: section.title,
            body: ["RICH_TEXT", "NOTICE", "FORMATTED_TEXT", "IMAGE", "CUSTOM_HTML"].includes(section.kind) ? body : "",
            tone: section.kind === "NOTICE" ? section.tone ?? "INFO" : null,
            placement: section.placement,
            items: section.kind === "STEPS" || section.kind === "CHECKLIST"
              ? section.items.map((item) => ({
                title: item.title,
                text: section.kind === "STEPS" ? item.text : "",
              }))
              : [],
            data: data ?? {},
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
            assets: blockAssets.length > 0
              ? { create: blockAssets.map((assetId) => ({ assetId })) }
              : undefined,
          },
        });
      }
      const publishedCount = input.sections.filter((section) => section.isPublished).length;
      const customHtmlCount = input.sections.filter((section) => section.kind === "CUSTOM_HTML").length;
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
            customHtmlCount,
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
      && assetsToCheck.length > 0
      && await prisma.eventAsset.count({ where: { id: { in: assetsToCheck }, eventId } }) < assetsToCheck.length
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
