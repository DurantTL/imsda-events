import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  ensureEventMessagingDefaults,
  processQueuedMessageIdsAfterCommit,
} from "@/modules/communications/messaging-repository";
import {
  enqueueEventAnnouncementMessage,
} from "@/modules/communications/transactional-messages";

export class AnnouncementBroadcastError extends Error {
  constructor(
    public readonly code:
      | "ANNOUNCEMENT_NOT_FOUND"
      | "ANNOUNCEMENT_NOT_PUBLISHED"
      | "NO_ACTIVE_REGISTRATIONS",
    message: string,
  ) {
    super(message);
    this.name = "AnnouncementBroadcastError";
  }
}

export async function broadcastPublishedAnnouncement(input: {
  eventId: string;
  announcementId: string;
  batchId: string;
  actorUserId: string;
}) {
  await ensureEventMessagingDefaults(input.eventId);
  const result = await getPrisma().$transaction(async (tx) => {
    const announcement = await tx.announcement.findFirst({
      where: { id: input.announcementId, eventId: input.eventId },
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        publishedAt: true,
      },
    });
    if (!announcement) {
      throw new AnnouncementBroadcastError(
        "ANNOUNCEMENT_NOT_FOUND",
        "That announcement no longer exists.",
      );
    }
    if (announcement.status !== "PUBLISHED" || !announcement.publishedAt) {
      throw new AnnouncementBroadcastError(
        "ANNOUNCEMENT_NOT_PUBLISHED",
        "Publish the announcement to the attendee feed before emailing it.",
      );
    }
    const registrations = await tx.registration.findMany({
      where: {
        eventId: input.eventId,
        status: { in: ["SUBMITTED", "CONFIRMED"] },
      },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (registrations.length === 0) {
      throw new AnnouncementBroadcastError(
        "NO_ACTIVE_REGISTRATIONS",
        "There are no active registrations to notify.",
      );
    }

    const messageIds: string[] = [];
    const pendingMessageIds: string[] = [];
    let skippedCount = 0;
    let deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL" = "LOCAL_CAPTURE";
    for (const registration of registrations) {
      const queued = await enqueueEventAnnouncementMessage(tx, {
        eventId: input.eventId,
        registrationId: registration.id,
        correlationId: input.batchId,
        transitionKey: `announcement-broadcast:${announcement.id}:${input.batchId}`,
        announcementTitle: announcement.title,
        announcementBody: announcement.body,
        metadata: {
          trigger: "STAFF_EVENT_ANNOUNCEMENT_BROADCAST",
          announcementId: announcement.id,
          batchId: input.batchId,
        },
      });
      deliveryMode = queued.deliveryMode;
      messageIds.push(...queued.messageIds);
      pendingMessageIds.push(...queued.pendingMessageIds);
      if (queued.skippedReason) skippedCount += 1;
    }
    await tx.auditLog.create({
      data: {
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "EVENT_ANNOUNCEMENT_BROADCAST_ENQUEUED",
        entityType: "Announcement",
        entityId: announcement.id,
        correlationId: input.batchId,
        summary: `Prepared the published announcement “${announcement.title}” for ${messageIds.length} active registration contact${messageIds.length === 1 ? "" : "s"}.`,
        metadata: {
          announcementId: announcement.id,
          batchId: input.batchId,
          activeRegistrationCount: registrations.length,
          messageCount: messageIds.length,
          skippedCount,
          deliveryMode,
        },
      },
    });
    return {
      messageIds,
      pendingMessageIds,
      skippedCount,
      deliveryMode,
    };
  });
  await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
  return {
    broadcastId: input.batchId,
    announcementId: input.announcementId,
    messageCount: result.messageIds.length,
    skippedCount: result.skippedCount,
    deliveryMode: result.deliveryMode,
  };
}
