import "server-only";

import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/prisma";

/**
 * The artwork printed behind every name badge for an event.
 *
 * Reuses the event file library rather than adding a second upload path: that
 * library already refuses anything whose bytes do not match the type it claims
 * to be, and serves what it stores with headers that stop it becoming
 * something else. A badge background is one of those files, pointed at.
 */

export class BadgeBackgroundError extends Error {
  constructor(
    public readonly code:
      | "ASSET_NOT_FOUND"
      | "ASSET_NOT_AN_IMAGE",
    message: string,
  ) {
    super(message);
    this.name = "BadgeBackgroundError";
  }
}

export type BadgeBackgroundOption = {
  id: string;
  displayName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  url: string;
};

function badgeBackgroundUrl(eventId: string) {
  return `/api/events/${encodeURIComponent(eventId)}/badge-background`;
}

function assetPreviewUrl(eventId: string, assetId: string) {
  return `/api/events/${encodeURIComponent(eventId)}/assets/${encodeURIComponent(assetId)}?disposition=inline`;
}

/** Only images: a PDF is downloadable from the file library but cannot be a
 * printable background, and offering one only produces an empty badge. */
export async function listBadgeBackgroundOptions(
  eventId: string,
): Promise<BadgeBackgroundOption[]> {
  const assets = await getPrisma().eventAsset.findMany({
    where: { eventId, contentType: { startsWith: "image/" } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      displayName: true,
      contentType: true,
      byteSize: true,
      createdAt: true,
    },
  });
  return assets.map((asset) => ({
    ...asset,
    createdAt: asset.createdAt.toISOString(),
    url: assetPreviewUrl(eventId, asset.id),
  }));
}

export async function getEventBadgeBackground(eventId: string) {
  const event = await getPrisma().event.findUnique({
    where: { id: eventId },
    select: {
      badgeBackgroundAssetId: true,
      badgeBackground: {
        select: { id: true, displayName: true, contentType: true, storageKey: true },
      },
    },
  });
  if (!event?.badgeBackground) return null;
  return {
    id: event.badgeBackground.id,
    displayName: event.badgeBackground.displayName,
    contentType: event.badgeBackground.contentType,
    storageKey: event.badgeBackground.storageKey,
    url: badgeBackgroundUrl(eventId),
  };
}

export async function setEventBadgeBackground(
  eventId: string,
  assetId: string | null,
  actorUserId: string,
) {
  const prisma = getPrisma();
  if (assetId) {
    const asset = await prisma.eventAsset.findFirst({
      where: { id: assetId, eventId },
      select: { id: true, displayName: true, contentType: true },
    });
    if (!asset) {
      throw new BadgeBackgroundError(
        "ASSET_NOT_FOUND",
        "That file is not available on this event.",
      );
    }
    if (!asset.contentType.startsWith("image/")) {
      throw new BadgeBackgroundError(
        "ASSET_NOT_AN_IMAGE",
        "Choose a PNG, JPEG, or WebP image for the badge background.",
      );
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.event.update({
      where: { id: eventId },
      data: { badgeBackgroundAssetId: assetId },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: assetId ? "EVENT_BADGE_BACKGROUND_SET" : "EVENT_BADGE_BACKGROUND_CLEARED",
        entityType: "Event",
        entityId: eventId,
        correlationId: randomUUID(),
        summary: assetId
          ? "Set the printed name badge background artwork."
          : "Removed the printed name badge background artwork.",
        metadata: { assetId, productionWrite: false },
      },
    });
  });
  return getEventBadgeBackground(eventId);
}
