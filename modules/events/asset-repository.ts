import "server-only";

import { randomUUID } from "node:crypto";
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
  /** Titles of draft (unpublished) sections that link this file. These never
   * block delete — nothing public depends on a draft — so deleting the file
   * quietly drops the tile's reference to it instead. */
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
  badgeBackgroundEvents: Array<{ id: string }>;
}): EventAssetUsage {
  const published = new Set<string>();
  const draft = new Set<string>();
  for (const link of asset.links) {
    (link.section.isPublished ? published : draft).add(link.section.title);
  }
  return {
    publishedSectionTitles: [...published],
    draftSectionTitles: [...draft],
    isBadgeBackground: asset.badgeBackgroundEvents.length > 0,
  };
}

const usageSelect = {
  links: { select: { section: { select: { title: true, isPublished: true } } } },
  badgeBackgroundEvents: { select: { id: true } },
} as const;

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
      ...usageSelect,
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

/**
 * Deletes an uploaded file, refusing while anything public still depends on
 * it.
 *
 * A **published** section's resource tile, or the event's current badge
 * background, blocks the delete outright — the message names exactly what
 * uses it, so staff know what to undo first. A **draft** section's tile does
 * not block: nothing public depends on it, so the tile's reference to the
 * file is cleared as part of the same deletion rather than making staff hunt
 * it down first. Merchandise artwork always blocks, matching how the
 * merchandise catalog already treats its artwork file.
 */
export async function removeEventAsset(eventId: string, assetId: string, actorUserId: string) {
  const prisma = getPrisma();
  const asset = await prisma.eventAsset.findFirst({
    where: { id: assetId, eventId },
    select: {
      id: true,
      displayName: true,
      storageKey: true,
      links: { select: { id: true, section: { select: { title: true, isPublished: true } } } },
      badgeBackgroundEvents: { select: { id: true } },
      _count: { select: { merchandiseArtworkProducts: true } },
    },
  });
  if (!asset) {
    throw new EventAssetError("ASSET_NOT_FOUND", "That file is no longer available.");
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

  const draftLinkIds = asset.links.filter((link) => !link.section.isPublished).map((link) => link.id);
  await prisma.$transaction(async (tx) => {
    if (draftLinkIds.length > 0) {
      // These tiles only ever pointed at this file; with the file gone they
      // have nothing left to point at, so the tile goes with it rather than
      // being left dangling in someone's draft.
      await tx.eventContentLink.deleteMany({ where: { id: { in: draftLinkIds } } });
    }
    await tx.eventAsset.delete({ where: { id: asset.id } });
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
  });
  await deleteAsset(asset.storageKey);
}

/** Staff view: any asset belonging to the event. */
export async function findEventAssetForStaff(eventId: string, assetId: string) {
  return getPrisma().eventAsset.findFirst({
    where: { id: assetId, eventId },
    select: { displayName: true, contentType: true, storageKey: true },
  });
}

/**
 * Public view: an asset is reachable only while a *published* section of a
 * *published* event links to it, or it is the artwork of a merchandise
 * product whose catalog is enabled and approved.
 *
 * Serving by id alone would mean an uploaded-but-unpublished file — next
 * year's pricing, a draft schedule — is one guessed identifier from being
 * public. Unpublishing a section (or disabling/archiving a product, or
 * pulling catalog approval) takes its files down with it, which is what
 * unpublishing is for.
 */
export async function findPublishedEventAsset(assetId: string) {
  return getPrisma().eventAsset.findFirst({
    where: {
      id: assetId,
      event: { isPublished: true },
      OR: [
        { links: { some: { section: { isPublished: true } } } },
        {
          merchandiseArtworkProducts: {
            some: {
              isEnabled: true,
              isArchived: false,
              event: { merchandiseCatalog: { isEnabled: true, status: "APPROVED" } },
            },
          },
        },
      ],
    },
    select: { displayName: true, contentType: true, storageKey: true },
  });
}
