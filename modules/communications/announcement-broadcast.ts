import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  computeAnnouncementBroadcastPreview,
  resolveAnnouncementBroadcastAudience,
} from "@/modules/communications/announcement-broadcast-preview";
import {
  ensureEventMessagingDefaults,
  processQueuedMessageIdsAfterCommit,
} from "@/modules/communications/messaging-repository";
import {
  enqueueEventAnnouncementMessage,
} from "@/modules/communications/transactional-messages";
import { buildSeminarPreferencesBlocks } from "@/modules/communications/seminar-preferences";
import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

export class AnnouncementBroadcastError extends Error {
  constructor(
    public readonly code:
      | "ANNOUNCEMENT_NOT_FOUND"
      | "ANNOUNCEMENT_NOT_PUBLISHED"
      | "NO_ACTIVE_REGISTRATIONS"
      | "PREVIEW_REQUIRED"
      | "PREVIEW_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "AnnouncementBroadcastError";
  }
}

/**
 * One transaction enqueues every recipient, so Prisma's 5-second default would
 * roll back a large send. Sized from the timed check in
 * scripts/verify-announcement-email.ts, with wide headroom.
 */
const BROADCAST_TRANSACTION_TIMEOUT_MS = 120_000;
const BROADCAST_TRANSACTION_MAX_WAIT_MS = 15_000;

type BroadcastDatabaseClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/**
 * Loads what both the review and the send need, through the same query, so
 * the preview's counts and fingerprint are computed exactly as the send will
 * recompute them inside its transaction.
 */
async function loadAnnouncementBroadcastState(
  client: BroadcastDatabaseClient,
  input: { eventId: string; announcementId: string },
) {
  const announcement = await client.announcement.findFirst({
    where: { id: input.announcementId, eventId: input.eventId },
    select: { id: true, title: true, body: true, status: true, publishedAt: true },
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
  const [registrations, settings, template] = await Promise.all([
    client.registration.findMany({
      where: { eventId: input.eventId, status: { in: ["SUBMITTED", "CONFIRMED"] } },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        contactSnapshot: true,
        accountHolderPerson: { select: { normalizedEmail: true } },
      },
    }),
    client.eventMessageSettings.findUnique({
      where: { eventId: input.eventId },
      select: { deliveryMode: true },
    }),
    client.eventMessageTemplate.findUnique({
      where: { eventId_key: { eventId: input.eventId, key: "EVENT_ANNOUNCEMENT" } },
      select: {
        isEnabled: true,
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { id: true },
        },
      },
    }),
  ]);
  const candidates = registrations.map((registration) => ({
    registrationId: registration.id,
    contactSnapshot: registration.contactSnapshot,
    accountHolderNormalizedEmail: registration.accountHolderPerson?.normalizedEmail ?? null,
  }));
  const { recipients } = resolveAnnouncementBroadcastAudience(candidates);
  const preview = computeAnnouncementBroadcastPreview(
    candidates,
    {
      eventId: input.eventId,
      announcement: { id: announcement.id, title: announcement.title, body: announcement.body },
      deliveryMode: settings?.deliveryMode ?? "LOCAL_CAPTURE",
      // Matches the send: a missing template row is not suppressed.
      templateEnabled: template?.isEnabled !== false,
      templateVersionId: template?.versions[0]?.id ?? null,
    },
  );
  return { announcement, registrations, recipients, preview };
}

/**
 * Read-only counterpart to `broadcastPublishedAnnouncement` (#472): who the
 * send will reach, who it will skip for having no contact email, whether the
 * messages will be suppressed, and the fingerprint the send must echo back.
 * Never enqueues a message or writes an audit row.
 */
export async function previewAnnouncementBroadcast(input: {
  eventId: string;
  announcementId: string;
}): Promise<AnnouncementBroadcastPreview> {
  // The send ensures these defaults before it fingerprints, so the review
  // must too, or a first-ever send would always look stale.
  await ensureEventMessagingDefaults(input.eventId);
  return (await loadAnnouncementBroadcastState(getPrisma(), input)).preview;
}

export async function broadcastPublishedAnnouncement(input: {
  eventId: string;
  announcementId: string;
  batchId: string;
  previewFingerprint: string;
  actorUserId: string;
}) {
  await ensureEventMessagingDefaults(input.eventId);
  const result = await getPrisma().$transaction(async (tx) => {
    // Serializes concurrent sends of the same announcement, so a retry that
    // races the original waits and then finds its audit row below.
    await tx.$queryRaw`
      SELECT "id" FROM "Announcement"
      WHERE "id" = ${input.announcementId} AND "eventId" = ${input.eventId}
      FOR UPDATE
    `;
    // A retry of a batch that already committed (a timeout, or a 500 after
    // commit) returns what was recorded, before the fingerprint check: the
    // audience may have moved since, but nothing new is sent either way.
    const existingAudit = await tx.auditLog.findFirst({
      where: {
        eventId: input.eventId,
        action: "EVENT_ANNOUNCEMENT_BROADCAST_ENQUEUED",
        entityId: input.announcementId,
        correlationId: input.batchId,
      },
      select: { metadata: true },
    });
    if (existingAudit) {
      const metadata = existingAudit.metadata && typeof existingAudit.metadata === "object"
        && !Array.isArray(existingAudit.metadata)
        ? existingAudit.metadata as Record<string, unknown>
        : {};
      const pending = await tx.messageOutbox.findMany({
        where: {
          eventId: input.eventId,
          correlationId: input.batchId,
          templateKey: "EVENT_ANNOUNCEMENT",
          status: "PENDING",
        },
        select: { id: true },
      });
      const storedMode = metadata.deliveryMode;
      return {
        messageIds: [] as string[],
        messageCount: typeof metadata.messageCount === "number" ? metadata.messageCount : 0,
        pendingMessageIds: pending.map((message) => message.id),
        skippedCount: typeof metadata.skippedCount === "number" ? metadata.skippedCount : 0,
        deliveryMode: storedMode === "DISABLED" || storedMode === "EXTERNAL_EMAIL"
          ? storedMode
          : "LOCAL_CAPTURE" as const,
        replayed: true,
      };
    }

    const { announcement, registrations, recipients, preview } = await loadAnnouncementBroadcastState(tx, input);
    if (preview.fingerprint !== input.previewFingerprint) {
      throw new AnnouncementBroadcastError(
        "PREVIEW_CHANGED",
        "The recipients, template, or announcement changed since you reviewed it. Review it again before sending.",
      );
    }
    if (preview.recipientCount === 0) {
      throw new AnnouncementBroadcastError(
        "NO_ACTIVE_REGISTRATIONS",
        "There are no active registrations with a contact email to notify.",
      );
    }

    // Seminar blocks for every recipient in a few queries, and only when the
    // published template uses the token, so the loop below stays one set of
    // writes per recipient rather than a set of reads as well.
    const publishedTemplate = await tx.eventMessageTemplate.findUnique({
      where: { eventId_key: { eventId: input.eventId, key: "EVENT_ANNOUNCEMENT" } },
      select: {
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { subjectTemplate: true, bodyTemplate: true },
        },
      },
    });
    const publishedVersion = publishedTemplate?.versions[0];
    const seminarBlocks = /\{\{\s*seminar_preferences\s*\}\}/.test(
      `${publishedVersion?.subjectTemplate ?? ""}\n${publishedVersion?.bodyTemplate ?? ""}`,
    )
      ? await buildSeminarPreferencesBlocks(tx, {
          eventId: input.eventId,
          registrationIds: recipients.map((recipient) => recipient.registrationId),
        })
      : null;

    const messageIds: string[] = [];
    const pendingMessageIds: string[] = [];
    // Registrations with no contact email were reviewed as skipped.
    let skippedCount = preview.skippedNoEmailCount;
    let deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL" = preview.deliveryMode;
    for (const recipient of recipients) {
      const queued = await enqueueEventAnnouncementMessage(tx, {
        eventId: input.eventId,
        registrationId: recipient.registrationId,
        recipientEmail: recipient.recipientEmail,
        correlationId: input.batchId,
        transitionKey: `announcement-broadcast:${announcement.id}:${input.batchId}`,
        announcementTitle: announcement.title,
        announcementBody: announcement.body,
        ...(seminarBlocks
          ? { seminarPreferencesBlock: seminarBlocks.get(recipient.registrationId) ?? "" }
          : {}),
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
          previewFingerprint: input.previewFingerprint,
          activeRegistrationCount: registrations.length,
          messageCount: messageIds.length,
          skippedCount,
          deliveryMode,
        },
      },
    });
    return {
      messageIds,
      messageCount: messageIds.length,
      pendingMessageIds,
      skippedCount,
      deliveryMode,
      replayed: false,
    };
  }, { timeout: BROADCAST_TRANSACTION_TIMEOUT_MS, maxWait: BROADCAST_TRANSACTION_MAX_WAIT_MS });
  await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
  return {
    broadcastId: input.batchId,
    announcementId: input.announcementId,
    messageCount: result.messageCount,
    skippedCount: result.skippedCount,
    deliveryMode: result.deliveryMode,
    replayed: result.replayed,
  };
}
