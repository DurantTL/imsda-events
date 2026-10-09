import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  announcementRecipientEmail,
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
import { BATCH_TRANSACTION_MAX_WAIT_MS, BATCH_TRANSACTION_TIMEOUT_MS } from "@/modules/communications/batch-transaction";
import { loadAnnouncementOptOuts } from "@/modules/communications/email-preferences-repository";
import { linkQueuedMessageFiles } from "@/modules/communications/message-files";
import { inlineImageSetIssue, messageFileIdsInMarkdown } from "@/modules/communications/message-file-rules";
import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

export class AnnouncementBroadcastError extends Error {
  constructor(
    public readonly code:
      | "ANNOUNCEMENT_NOT_FOUND"
      | "ANNOUNCEMENT_NOT_PUBLISHED"
      | "NO_ACTIVE_REGISTRATIONS"
      | "PREVIEW_REQUIRED"
      | "PREVIEW_CHANGED"
      | "ATTACHMENTS_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "AnnouncementBroadcastError";
  }
}

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
    select: { id: true, title: true, body: true, status: true, publishedAt: true, isEssential: true },
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
  const [registrations, settings, template, announcementFiles] = await Promise.all([
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
          select: {
            id: true,
            bodyTemplate: true,
            files: { orderBy: { position: "asc" }, select: { file: { select: { id: true, filename: true, sizeBytes: true } } } },
          },
        },
      },
    }),
    client.announcementFile.findMany({
      where: { announcementId: input.announcementId },
      orderBy: { position: "asc" },
      select: { file: { select: { id: true, filename: true, sizeBytes: true } } },
    }),
  ]);
  // The announcement's own files first, then the template version's, each once.
  const attachments: Array<{ id: string; filename: string; sizeBytes: number }> = [];
  for (const link of [...announcementFiles, ...(template?.versions[0]?.files ?? [])]) {
    if (!attachments.some((file) => file.id === link.file.id)) attachments.push(link.file);
  }
  // The pictures the message will embed: those in the announcement's own body and in the template's. They are checked
  // here, in the review, so a send never fails on one (as the save checks them too).
  const pictureIds = [...new Set([
    ...messageFileIdsInMarkdown(announcement.body),
    ...messageFileIdsInMarkdown(template?.versions[0]?.bodyTemplate ?? ""),
  ])];
  let pictureProblem: string | null = null;
  if (pictureIds.length > 0) {
    const pictures = await client.messageFile.findMany({
      where: { id: { in: pictureIds }, eventId: input.eventId, isInlineImage: true },
      select: { sizeBytes: true },
    });
    pictureProblem = pictures.length !== pictureIds.length
      ? "A picture in this announcement or its template is no longer available. Edit it and insert the picture again."
      : inlineImageSetIssue(pictures)?.message ?? null;
  }
  const candidates = registrations.map((registration) => ({
    registrationId: registration.id,
    contactSnapshot: registration.contactSnapshot,
    accountHolderNormalizedEmail: registration.accountHolderPerson?.normalizedEmail ?? null,
  }));
  // Opt-outs (#838), read through the same client as the send, so the review's counts are what the send applies.
  const optOuts = await loadAnnouncementOptOuts(
    client,
    candidates.map((candidate) => announcementRecipientEmail(candidate.contactSnapshot, candidate.accountHolderNormalizedEmail)),
    input.eventId,
  );
  const { recipients } = resolveAnnouncementBroadcastAudience(candidates, {
    eventId: input.eventId,
    optOuts,
    essential: announcement.isEssential,
  });
  const preview = computeAnnouncementBroadcastPreview(
    candidates,
    {
      eventId: input.eventId,
      announcement: { id: announcement.id, title: announcement.title, body: announcement.body },
      deliveryMode: settings?.deliveryMode ?? "LOCAL_CAPTURE",
      // Matches the send: a missing template row is not suppressed.
      templateEnabled: template?.isEnabled !== false,
      templateVersionId: template?.versions[0]?.id ?? null,
      attachments,
      pictureIds,
      pictureProblem,
      essential: announcement.isEssential,
    },
    undefined,
    optOuts,
  );
  return { announcement, registrations, recipients, preview, attachments };
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
        optedOutCount: typeof metadata.skippedOptedOutCount === "number" ? metadata.skippedOptedOutCount : 0,
        deliveryMode: storedMode === "DISABLED" || storedMode === "EXTERNAL_EMAIL"
          ? storedMode
          : "LOCAL_CAPTURE" as const,
        replayed: true,
      };
    }

    const { announcement, registrations, recipients, preview, attachments } = await loadAnnouncementBroadcastState(tx, input);
    if (preview.fingerprint !== input.previewFingerprint) {
      throw new AnnouncementBroadcastError(
        "PREVIEW_CHANGED",
        "The recipients, template, or announcement changed since you reviewed it. Review it again before sending.",
      );
    }
    if (preview.attachmentProblem) {
      throw new AnnouncementBroadcastError("ATTACHMENTS_INVALID", preview.attachmentProblem);
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
    const seminarBlocks = /\{\{\s*seminar\\?_preferences\s*\}\}/.test(
      `${publishedVersion?.subjectTemplate ?? ""}\n${publishedVersion?.bodyTemplate ?? ""}`,
    )
      ? await buildSeminarPreferencesBlocks(tx, {
          eventId: input.eventId,
          registrationIds: recipients.map((recipient) => recipient.registrationId),
        })
      : null;

    const messageIds: string[] = [];
    const pendingMessageIds: string[] = [];
    // Registrations with no contact email, and those opted out of announcements (#838), were reviewed as skipped.
    let skippedCount = preview.skippedNoEmailCount + preview.skippedOptedOutCount;
    let deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL" = preview.deliveryMode;
    for (const recipient of recipients) {
      const queued = await enqueueEventAnnouncementMessage(tx, {
        eventId: input.eventId,
        registrationId: recipient.registrationId,
        recipientEmail: recipient.recipientEmail,
        correlationId: input.batchId,
        transitionKey: `announcement-broadcast:${announcement.id}:${input.batchId}`,
        // Files are linked for the whole batch below, in one pass.
        deferFileLinking: true,
        announcementTitle: announcement.title,
        announcementBody: announcement.body,
        ...(seminarBlocks
          ? { seminarPreferencesBlock: seminarBlocks.get(recipient.registrationId) ?? "" }
          : {}),
        metadata: {
          trigger: "STAFF_EVENT_ANNOUNCEMENT_BROADCAST",
          announcementId: announcement.id,
          batchId: input.batchId,
          // Delivery re-checks opt-outs right before sending, and honours this flag (#838).
          essential: announcement.isEssential,
        },
      });
      deliveryMode = queued.deliveryMode;
      messageIds.push(...queued.messageIds);
      pendingMessageIds.push(...queued.pendingMessageIds);
      if (queued.skippedReason) skippedCount += 1;
    }
    // The template version's attachments, the announcement's own, and each message's embedded images.
    await linkQueuedMessageFiles(tx, {
      eventId: input.eventId,
      messageIds,
      extraAttachmentFileIds: (await tx.announcementFile.findMany({
        where: { announcementId: announcement.id },
        orderBy: { position: "asc" },
        select: { fileId: true },
      })).map((row) => row.fileId),
    });
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
          skippedNoEmailCount: preview.skippedNoEmailCount,
          skippedOptedOutCount: preview.skippedOptedOutCount,
          skippedOptedOutEventCount: preview.skippedOptedOutEventCount,
          skippedOptedOutAllCount: preview.skippedOptedOutAllCount,
          essential: announcement.isEssential,
          essentialOptedOutReachedCount: preview.essentialOptedOutReachedCount,
          deliveryMode,
          // File names and sizes only (#824).
          attachments: attachments.map((file) => ({ filename: file.filename, sizeBytes: file.sizeBytes })),
        },
      },
    });
    return {
      messageIds,
      messageCount: messageIds.length,
      pendingMessageIds,
      skippedCount,
      optedOutCount: preview.skippedOptedOutCount,
      deliveryMode,
      replayed: false,
    };
  }, { timeout: BATCH_TRANSACTION_TIMEOUT_MS, maxWait: BATCH_TRANSACTION_MAX_WAIT_MS });
  // Real email with files is left to the outbox worker inside `processQueuedMessageIdsAfterCommit`.
  await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
  return {
    broadcastId: input.batchId,
    announcementId: input.announcementId,
    messageCount: result.messageCount,
    skippedCount: result.skippedCount,
    optedOutCount: result.optedOutCount,
    deliveryMode: result.deliveryMode,
    replayed: result.replayed,
  };
}
