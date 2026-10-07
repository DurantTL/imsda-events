import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { logError } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";
import {
  bytesMatchType,
  deleteAsset,
  isAllowedAssetType,
  safeDisplayName,
  writeAsset,
  MAX_ASSET_BYTES,
  type AllowedAssetType,
} from "@/modules/events/asset-storage";

export class EventAssetError extends Error {
  constructor(
    public readonly code:
      | "ASSET_TYPE_NOT_ALLOWED"
      | "ASSET_TOO_LARGE"
      | "ASSET_CONTENT_MISMATCH"
      | "ASSET_NOT_FOUND"
      | "ASSET_IN_USE",
    message: string,
  ) {
    super(message);
    this.name = "EventAssetError";
  }
}

/** Where an uploaded file is referenced from, for the staff file list and for
 * deciding whether a delete is safe. */
export type EventAssetUsage = {
  /** Titles of published sections whose resource tiles link this file. A
   * non-empty list blocks delete: a visitor could be looking at it. */
  publishedSectionTitles: string[];
  /** Titles of draft (unpublished) sections that link this file. Nothing
   * public depends on a draft, so deleting the file removes those tiles —
   * unless that would leave a resource-links draft with no links at all,
   * which the delete refuses (see removeEventAsset). */
  draftSectionTitles: string[];
  /** Whether this file is the event's current printed name-badge background. */
  isBadgeBackground: boolean;
};

export type EventAssetRecord = {
  id: string;
  displayName: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  usage: EventAssetUsage;
  /** Only ever inline for a verified image type — see eventAssetResponse. */
  url: string;
};

function assetInlineUrl(eventId: string, assetId: string) {
  return `/api/events/${encodeURIComponent(eventId)}/assets/${encodeURIComponent(assetId)}?disposition=inline`;
}

function summarizeUsage(asset: {
  links: Array<{ section: { title: string; isPublished: boolean } }>;
  /** Pictures shown by the #816 blocks (banner, photos, gallery, speakers). */
  blockRefs?: Array<{ section: { title: string; isPublished: boolean } }>;
  badgeBackgroundEvents: Array<{ id: string }>;
}): EventAssetUsage {
  const published = new Set<string>();
  const draft = new Set<string>();
  for (const link of [...asset.links, ...(asset.blockRefs ?? [])]) {
    (link.section.isPublished ? published : draft).add(link.section.title);
  }
  return {
    publishedSectionTitles: [...published],
    draftSectionTitles: [...draft],
    isBadgeBackground: asset.badgeBackgroundEvents.length > 0,
  };
}

/** Usage is scoped to this event's own sections, so another event's section
 * titles can never surface in this event's file list or delete messages. */
function usageSelect(eventId: string) {
  return {
    links: {
      where: { section: { eventId } },
      select: { section: { select: { title: true, isPublished: true } } },
    },
    blockRefs: {
      where: { section: { eventId } },
      select: { section: { select: { title: true, isPublished: true } } },
    },
    badgeBackgroundEvents: { select: { id: true } },
  } as const;
}

export async function listEventAssets(eventId: string): Promise<EventAssetRecord[]> {
  const assets = await getPrisma().eventAsset.findMany({
    where: { eventId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      displayName: true,
      contentType: true,
      byteSize: true,
      createdAt: true,
      ...usageSelect(eventId),
    },
  });
  return assets.map((asset) => ({
    id: asset.id,
    displayName: asset.displayName,
    filename: asset.displayName,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    createdAt: asset.createdAt.toISOString(),
    usage: summarizeUsage(asset),
    url: assetInlineUrl(eventId, asset.id),
  }));
}

/**
 * Stores an upload after checking it is what it says it is.
 *
 * The order matters. Size is checked before the bytes are read into memory,
 * the declared type is checked against an allow-list, and only then are the
 * bytes compared with the signature that type requires. A file that fails any
 * of these is never written, so a rejected upload leaves nothing behind.
 */
export async function createEventAsset(
  eventId: string,
  file: File,
  actorUserId: string,
): Promise<EventAssetRecord> {
  if (file.size > MAX_ASSET_BYTES) {
    throw new EventAssetError(
      "ASSET_TOO_LARGE",
      `Files must be ${Math.floor(MAX_ASSET_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }
  const declaredType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isAllowedAssetType(declaredType)) {
    throw new EventAssetError(
      "ASSET_TYPE_NOT_ALLOWED",
      "Upload a PDF, PNG, JPEG, or WebP file.",
    );
  }
  const type: AllowedAssetType = declaredType;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytesMatchType(bytes, type)) {
    // The multipart Content-Type is a claim. Serving a mismatched file back
    // under the claimed type is how an upload becomes something else entirely.
    throw new EventAssetError(
      "ASSET_CONTENT_MISMATCH",
      "That file's contents do not match the kind of file it claims to be.",
    );
  }

  const stored = await writeAsset(eventId, type, bytes);
  try {
    const asset = await getPrisma().eventAsset.create({
      data: {
        eventId,
        displayName: safeDisplayName(file.name, type),
        contentType: type,
        byteSize: stored.byteSize,
        checksum: stored.checksum,
        storageKey: stored.storageKey,
        uploadedByUserId: actorUserId,
      },
      select: { id: true, displayName: true, contentType: true, byteSize: true, createdAt: true },
    });
    return {
      ...asset,
      filename: asset.displayName,
      createdAt: asset.createdAt.toISOString(),
      usage: { publishedSectionTitles: [], draftSectionTitles: [], isBadgeBackground: false },
      url: assetInlineUrl(eventId, asset.id),
    };
  } catch (error) {
    // The row is the record of truth. Without it the file is unreachable and
    // unlistable, so it goes rather than sitting on disk forever.
    await deleteAsset(stored.storageKey);
    throw error;
  }
}

function namePublishedUse(titles: string[]) {
  const label = titles.length === 1
    ? `the published section "${titles[0]}"`
    : `the published sections ${titles.map((title) => `"${title}"`).join(", ")}`;
  return `Remove the tile that links to this file from ${label} before deleting it.`;
}

function nameEmptiedDrafts(titles: string[]) {
  const label = titles.length === 1
    ? `the draft section "${titles[0]}"`
    : `the draft sections ${titles.map((title) => `"${title}"`).join(", ")}`;
  const there = titles.length === 1 ? "there" : "to each";
  return `Remove it from ${label} and save first, or add another link ${there}. It is the only link, and a resource-links section needs at least one.`;
}

export type RemovedEventAsset = {
  /** Draft sections whose tiles for this file were removed with it. */
  removedFromDraftSectionTitles: string[];
};

const JUST_LINKED_MESSAGE = "This file was just linked; reload and try again.";

/**
 * Deletes an uploaded file, refusing while anything public still depends on
 * it.
 *
 * A **published** section's resource tile, or the event's current badge
 * background, blocks the delete outright — the message names exactly what
 * uses it, so staff know what to undo first. A **draft** section's tile does
 * not block: nothing public depends on it, so the tile is removed in the same
 * transaction. The one exception is a resource-links draft where this file is
 * its only link: removing the tile would leave a section the editor can no
 * longer save ("Add at least one link…"), so the delete is refused and names
 * that draft instead of silently deleting the section. Merchandise artwork
 * always blocks, matching how the merchandise catalog already treats its
 * artwork file.
 *
 * The lookup and every check run inside the transaction. A tile linked by a
 * concurrent save between check and delete trips the Restrict foreign key
 * (P2003); that is reported as ASSET_IN_USE rather than a generic failure.
 */
export async function removeEventAsset(
  eventId: string,
  assetId: string,
  actorUserId: string,
): Promise<RemovedEventAsset> {
  const prisma = getPrisma();
  let removed: { storageKey: string; removedFromDraftSectionTitles: string[] };
  try {
    removed = await prisma.$transaction(async (tx) => {
      const asset = await tx.eventAsset.findFirst({
        where: { id: assetId, eventId },
        select: {
          id: true,
          displayName: true,
          storageKey: true,
          links: {
            where: { section: { eventId } },
            select: {
              id: true,
              section: {
                select: {
                  id: true,
                  kind: true,
                  title: true,
                  body: true,
                  isPublished: true,
                  _count: { select: { links: true } },
                },
              },
            },
          },
          blockRefs: {
            where: { section: { eventId } },
            select: { section: { select: { title: true, isPublished: true } } },
          },
          badgeBackgroundEvents: { select: { id: true } },
          _count: { select: { merchandiseArtworkProducts: true } },
        },
      });
      if (!asset) {
        throw new EventAssetError("ASSET_NOT_FOUND", "That file is no longer available.");
      }

      // A picture shown by a content block (#816). Unlike a resource tile it
      // cannot be dropped for staff, so a draft block refuses the delete too.
      const blockRefs = asset.blockRefs ?? [];
      if (blockRefs.length > 0) {
        const titles = [...new Set(blockRefs.map((ref) => ref.section.title))];
        const names = titles.map((title) => `"${title}"`).join(", ");
        throw new EventAssetError(
          "ASSET_IN_USE",
          `Remove this image from the block${titles.length === 1 ? "" : "s"} ${names} and save before deleting it.`,
        );
      }

      const publishedSectionTitles = [...new Set(
        asset.links.filter((link) => link.section.isPublished).map((link) => link.section.title),
      )];
      if (publishedSectionTitles.length > 0) {
        throw new EventAssetError("ASSET_IN_USE", namePublishedUse(publishedSectionTitles));
      }
      if (asset.badgeBackgroundEvents.length > 0) {
        throw new EventAssetError(
          "ASSET_IN_USE",
          "Remove this image as the name badge background before deleting it.",
        );
      }
      if (asset._count.merchandiseArtworkProducts > 0) {
        throw new EventAssetError(
          "ASSET_IN_USE",
          "Remove this artwork from the merchandise products that use it before deleting it.",
        );
      }

      const draftLinks = asset.links.filter((link) => !link.section.isPublished);
      const draftSections = new Map<string, { title: string; kind: string; body: string; total: number; removing: number }>();
      for (const link of draftLinks) {
        const entry = draftSections.get(link.section.id) ?? {
          title: link.section.title,
          kind: link.section.kind,
          body: link.section.body,
          total: link.section._count.links,
          removing: 0,
        };
        entry.removing += 1;
        draftSections.set(link.section.id, entry);
      }
      const emptiedTitles = [...draftSections.values()]
        .filter((section) => (
          section.removing >= section.total
          && (section.kind === "RESOURCE_LINKS" || (section.kind === "NOTICE" && section.body.trim() === ""))
        ))
        .map((section) => section.title);
      if (emptiedTitles.length > 0) {
        throw new EventAssetError("ASSET_IN_USE", nameEmptiedDrafts([...new Set(emptiedTitles)]));
      }

      const draftLinkIds = draftLinks.map((link) => link.id);
      if (draftLinkIds.length > 0) {
        // These tiles only ever pointed at this file; with the file gone they
        // have nothing left to point at. Each section keeps its other links.
        await tx.eventContentLink.deleteMany({ where: { id: { in: draftLinkIds } } });
      }
      await tx.eventAsset.delete({ where: { id: asset.id } });
      const removedFromDraftSectionTitles = [...new Set([...draftSections.values()].map((section) => section.title))];
      await tx.auditLog.create({
        data: {
          eventId,
          actorUserId,
          action: "EVENT_ASSET_DELETED",
          entityType: "EventAsset",
          entityId: asset.id,
          correlationId: randomUUID(),
          summary: `Deleted the uploaded file "${asset.displayName}".`,
          metadata: {
            assetId: asset.id,
            displayName: asset.displayName,
            clearedDraftTileCount: draftLinkIds.length,
            productionWrite: false,
          },
        },
      });
      return { storageKey: asset.storageKey, removedFromDraftSectionTitles };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new EventAssetError("ASSET_IN_USE", JUST_LINKED_MESSAGE);
    }
    throw error;
  }

  try {
    await deleteAsset(removed.storageKey);
  } catch (error) {
    // The row is already gone, so the delete the user asked for has happened.
    // A stray stored copy is unreachable (nothing can serve it without the
    // row); log it for cleanup rather than reporting a failure that didn't.
    logError("Removing a deleted event file's stored copy failed", error, { eventId, assetId });
  }
  return { removedFromDraftSectionTitles: removed.removedFromDraftSectionTitles };
}

/** Staff view: any asset belonging to the event. */
export async function findEventAssetForStaff(eventId: string, assetId: string) {
  return getPrisma().eventAsset.findFirst({
    where: { id: assetId, eventId },
    select: { displayName: true, contentType: true, storageKey: true },
  });
}

/**
 * Public view: an asset is reachable only while it belongs to the named
 * *published* event, and a *published* section of that same event links to
 * it, or it is the artwork of that same event's merchandise product whose
 * catalog is enabled and approved. Both the asset and the link are scoped to
 * the slug, so a cross-event link row saved before #508 can't expose a file.
 *
 * Serving by id alone would mean an uploaded-but-unpublished file — next
 * year's pricing, a draft schedule — is one guessed identifier from being
 * public, and would let one event's public page serve another event's file
 * by id even if that file happened to be linked from a published section
 * somewhere else. Scoping to `eventSlug` (the event whose page is being
 * rendered) closes both. Unpublishing a section (or disabling/archiving a
 * product, or pulling catalog approval) takes its files down with it, which
 * is what unpublishing is for.
 */
export async function findPublishedEventAsset(eventSlug: string, assetId: string) {
  return getPrisma().eventAsset.findFirst({
    where: {
      id: assetId,
      event: { slug: eventSlug, isPublished: true },
      OR: [
        { links: { some: { section: { isPublished: true, event: { slug: eventSlug } } } } },
        // A picture a published content block shows (#816).
        { blockRefs: { some: { section: { isPublished: true, event: { slug: eventSlug } } } } },
        {
          merchandiseArtworkProducts: {
            some: {
              isEnabled: true,
              isArchived: false,
              event: { slug: eventSlug, merchandiseCatalog: { isEnabled: true, status: "APPROVED" } },
            },
          },
        },
      ],
    },
    select: { displayName: true, contentType: true, storageKey: true },
  });
}
