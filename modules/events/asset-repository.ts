import "server-only";

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

export type EventAssetRecord = {
  id: string;
  displayName: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  linkCount: number;
  /** Only ever inline for a verified image type — see eventAssetResponse. */
  url: string;
};

function assetInlineUrl(eventId: string, assetId: string) {
  return `/api/events/${encodeURIComponent(eventId)}/assets/${encodeURIComponent(assetId)}?disposition=inline`;
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
      _count: { select: { links: true } },
    },
  });
  return assets.map((asset) => ({
    id: asset.id,
    displayName: asset.displayName,
    filename: asset.displayName,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    createdAt: asset.createdAt.toISOString(),
    linkCount: asset._count.links,
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
    return { ...asset, filename: asset.displayName, createdAt: asset.createdAt.toISOString(), linkCount: 0, url: assetInlineUrl(eventId, asset.id) };
  } catch (error) {
    // The row is the record of truth. Without it the file is unreachable and
    // unlistable, so it goes rather than sitting on disk forever.
    await deleteAsset(stored.storageKey);
    throw error;
  }
}

export async function removeEventAsset(eventId: string, assetId: string) {
  const prisma = getPrisma();
  const asset = await prisma.eventAsset.findFirst({
    where: { id: assetId, eventId },
    select: {
      id: true,
      storageKey: true,
      _count: { select: { links: true, merchandiseArtworkProducts: true } },
    },
  });
  if (!asset) {
    throw new EventAssetError("ASSET_NOT_FOUND", "That file is no longer available.");
  }
  if (asset._count.links > 0) {
    throw new EventAssetError(
      "ASSET_IN_USE",
      "Remove the tiles that link to this file before deleting it.",
    );
  }
  if (asset._count.merchandiseArtworkProducts > 0) {
    throw new EventAssetError(
      "ASSET_IN_USE",
      "Remove this artwork from the merchandise products that use it before deleting it.",
    );
  }
  await prisma.eventAsset.delete({ where: { id: asset.id } });
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
