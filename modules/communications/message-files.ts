import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { deleteAsset, readAsset, writeStoredFile } from "@/modules/events/asset-storage";
import {
  attachmentSetIssue,
  isMessageImageType,
  MAX_INLINE_IMAGE_BYTES,
  MAX_MESSAGE_FILE_BYTES,
  MESSAGE_FILE_TYPES,
  messageFileIdsInHtml,
  messageFileUrl,
  safeMessageFileName,
  sniffMessageFileType,
  type MessageFileRecord,
} from "@/modules/communications/message-file-rules";

export class MessageFileError extends Error {
  constructor(
    public readonly code:
      | "FILE_REQUIRED"
      | "FILE_EMPTY"
      | "FILE_TOO_LARGE"
      | "FILE_TYPE_NOT_ALLOWED"
      | "FILE_NOT_FOUND"
      | "FILE_SET_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "MessageFileError";
  }
}

type FileClient = PrismaClient | Prisma.TransactionClient;

const fileSelect = {
  id: true,
  eventId: true,
  filename: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  storageKey: true,
  isInlineImage: true,
  createdAt: true,
} as const;

type FileRow = {
  id: string;
  eventId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  isInlineImage: boolean;
  createdAt: Date;
};

export function toMessageFileRecord(row: Pick<FileRow, "id" | "eventId" | "filename" | "contentType" | "sizeBytes" | "isInlineImage" | "createdAt">): MessageFileRecord {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    isInlineImage: row.isInlineImage,
    createdAt: row.createdAt.toISOString(),
    url: messageFileUrl(row.eventId, row.id, row.isInlineImage ? "inline" : "attachment"),
  };
}

/**
 * Stores an upload after checking it is what its bytes say it is. Size comes first (before the bytes are read), then
 * the type is taken from the bytes alone, then the file is written under a generated name. A rejected upload leaves
 * nothing behind. `purpose` decides the size ceiling: an image for a message body is held to a small cap, because
 * every recipient downloads it with the message.
 */
export async function createMessageFile(
  eventId: string,
  file: File,
  actorUserId: string,
  purpose: "attachment" | "inline-image",
  client: PrismaClient = getPrisma(),
): Promise<MessageFileRecord> {
  const limit = purpose === "inline-image" ? MAX_INLINE_IMAGE_BYTES : MAX_MESSAGE_FILE_BYTES;
  if (file.size === 0) {
    throw new MessageFileError("FILE_EMPTY", "That file is empty.");
  }
  if (file.size > limit) {
    throw new MessageFileError(
      "FILE_TOO_LARGE",
      purpose === "inline-image"
        ? `Images in a message must be ${Math.floor(limit / (1024 * 1024))} MB or smaller.`
        : `Each attachment must be ${Math.floor(limit / (1024 * 1024))} MB or smaller.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffMessageFileType(bytes);
  if (!type || (purpose === "inline-image" && !isMessageImageType(type))) {
    throw new MessageFileError(
      "FILE_TYPE_NOT_ALLOWED",
      purpose === "inline-image"
        ? "Upload a PNG, JPEG, or WebP image."
        : "Attach a PDF, PNG, JPEG, WebP, Word, Excel, or PowerPoint file.",
    );
  }

  const stored = await writeStoredFile(`message-files/${eventId}`, MESSAGE_FILE_TYPES[type].extension, bytes);
  try {
    const row = await client.messageFile.create({
      data: {
        eventId,
        filename: safeMessageFileName(file.name, type),
        contentType: type,
        sizeBytes: stored.byteSize,
        sha256: stored.checksum,
        storageKey: stored.storageKey,
        isInlineImage: purpose === "inline-image",
        uploadedByUserId: actorUserId,
      },
      select: fileSelect,
    });
    await client.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MESSAGE_FILE_UPLOADED",
        entityType: "MessageFile",
        entityId: row.id,
        correlationId: randomUUID(),
        // Names and sizes only: never the content, its hash, or where it is stored.
        summary: `Uploaded ${purpose === "inline-image" ? "an image for a message" : "a message attachment"}: ${row.filename} (${row.sizeBytes} bytes).`,
        metadata: { files: [{ filename: row.filename, sizeBytes: row.sizeBytes }] },
      },
    });
    return toMessageFileRecord(row);
  } catch (error) {
    // The row is the record of truth; without it the file is unreachable, so it goes rather than sitting on disk.
    await deleteAsset(stored.storageKey).catch(() => undefined);
    throw error;
  }
}

/** The images uploaded for message bodies in this event, newest first, for the editor's picker. */
export async function listInlineImages(eventId: string, client: FileClient = getPrisma()) {
  const rows = await client.messageFile.findMany({
    where: { eventId, isInlineImage: true },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: fileSelect,
  });
  return rows.map(toMessageFileRecord);
}

export async function findMessageFileForStaff(eventId: string, fileId: string, client: FileClient = getPrisma()) {
  return client.messageFile.findFirst({
    where: { id: fileId, eventId },
    select: fileSelect,
  });
}

/** The bytes of a stored file, checked against the hash recorded at upload. */
export async function readMessageFileBytes(file: { storageKey: string; sha256: string }) {
  const bytes = await readAsset(file.storageKey);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new Error("A stored message file no longer matches its recorded hash.");
  }
  return bytes;
}

/**
 * The attachment files an author chose, in the order they chose them, checked to be this event's own downloadable
 * files and to fit the per-message limits together. Throws `FILE_SET_INVALID` otherwise.
 */
export async function resolveAttachmentSet(
  client: FileClient,
  eventId: string,
  fileIds: readonly string[],
) {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return [];
  const rows = await client.messageFile.findMany({
    where: { id: { in: unique }, eventId, isInlineImage: false },
    select: { id: true, sizeBytes: true },
  });
  if (rows.length !== unique.length) {
    throw new MessageFileError("FILE_SET_INVALID", "One of the attachments is no longer available. Remove it and attach it again.");
  }
  const issue = attachmentSetIssue(rows);
  if (issue) throw new MessageFileError("FILE_SET_INVALID", issue.message);
  return unique;
}

/** Every uploaded image a body refers to must be one of this event's own inline images. */
export async function assertBodyImagesBelongToEvent(
  client: FileClient,
  eventId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return;
  const count = await client.messageFile.count({
    where: { id: { in: [...ids] }, eventId, isInlineImage: true },
  });
  if (count !== new Set(ids).size) {
    throw new MessageFileError("FILE_SET_INVALID", "An image in the message is no longer available. Remove it and insert it again.");
  }
}

export async function listTemplateVersionFiles(
  client: FileClient,
  versionIds: readonly string[],
) {
  const byVersion = new Map<string, MessageFileRecord[]>();
  if (versionIds.length === 0) return byVersion;
  const rows = await client.messageTemplateVersionFile.findMany({
    where: { templateVersionId: { in: [...versionIds] } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { templateVersionId: true, file: { select: fileSelect } },
  });
  for (const row of rows) {
    const list = byVersion.get(row.templateVersionId) ?? [];
    list.push(toMessageFileRecord(row.file));
    byVersion.set(row.templateVersionId, list);
  }
  return byVersion;
}

export async function listAnnouncementFiles(
  client: FileClient,
  announcementIds: readonly string[],
) {
  const byAnnouncement = new Map<string, MessageFileRecord[]>();
  if (announcementIds.length === 0) return byAnnouncement;
  const rows = await client.announcementFile.findMany({
    where: { announcementId: { in: [...announcementIds] } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { announcementId: true, file: { select: fileSelect } },
  });
  for (const row of rows) {
    const list = byAnnouncement.get(row.announcementId) ?? [];
    list.push(toMessageFileRecord(row.file));
    byAnnouncement.set(row.announcementId, list);
  }
  return byAnnouncement;
}

/** Replaces an announcement's attachments with exactly `fileIds`. */
export async function setAnnouncementFiles(
  tx: Prisma.TransactionClient,
  eventId: string,
  announcementId: string,
  fileIds: readonly string[],
) {
  const ids = await resolveAttachmentSet(tx, eventId, fileIds);
  await tx.announcementFile.deleteMany({ where: { announcementId } });
  if (ids.length > 0) {
    await tx.announcementFile.createMany({
      data: ids.map((fileId, position) => ({ announcementId, fileId, position })),
    });
  }
  return ids;
}

/** Replaces a template version's attachments with exactly `fileIds`. */
export async function setTemplateVersionFiles(
  tx: Prisma.TransactionClient,
  eventId: string,
  templateVersionId: string,
  fileIds: readonly string[],
) {
  const ids = await resolveAttachmentSet(tx, eventId, fileIds);
  if (ids.length > 0) {
    await tx.messageTemplateVersionFile.createMany({
      data: ids.map((fileId, position) => ({ templateVersionId, fileId, position })),
    });
  }
  return ids;
}

/**
 * The attachment ids of a template's newest published version, for carrying forward into the next one.
 */
export async function latestPublishedVersionFileIds(client: FileClient, templateId: string) {
  const rows = await client.messageTemplateVersionFile.findMany({
    where: { templateVersion: { templateId, status: "PUBLISHED" } },
    orderBy: [{ templateVersion: { versionNumber: "desc" } }, { position: "asc" }],
    select: { fileId: true, templateVersion: { select: { versionNumber: true } } },
  });
  if (rows.length === 0) return [];
  const newest = rows[0].templateVersion.versionNumber;
  return rows.filter((row) => row.templateVersion.versionNumber === newest).map((row) => row.fileId);
}

/** What the audit trail may say about files: names and sizes. */
export async function describeFilesForAudit(client: FileClient, fileIds: readonly string[]) {
  if (fileIds.length === 0) return [];
  const rows = await client.messageFile.findMany({
    where: { id: { in: [...fileIds] } },
    select: { filename: true, sizeBytes: true },
  });
  return rows.map((row) => ({ filename: row.filename, sizeBytes: row.sizeBytes }));
}

/**
 * Writes the durable references from queued outbox rows to the files they send: the attachments of their template
 * version, any `extraAttachmentFileIds` (an announcement's own), and every uploaded image their rendered HTML embeds.
 * The delivery worker reads only these rows, so every attempt, retry and resend sends the same files.
 *
 * Reads what it needs from the rows themselves, so every place that queues messages calls it the same way, once
 * per batch, with the ids it just created.
 */
export async function linkQueuedMessageFiles(
  tx: FileClient,
  input: {
    eventId: string;
    messageIds: readonly string[];
    extraAttachmentFileIds?: readonly string[];
  },
) {
  if (input.messageIds.length === 0) return;
  const messages = await tx.messageOutbox.findMany({
    where: { id: { in: [...input.messageIds] }, eventId: input.eventId },
    select: { id: true, templateVersionId: true, bodyHtmlSnapshot: true },
  });
  const versionIds = [...new Set(messages.flatMap((message) => message.templateVersionId ? [message.templateVersionId] : []))];
  const versionFiles = versionIds.length > 0
    ? await tx.messageTemplateVersionFile.findMany({
        where: { templateVersionId: { in: versionIds } },
        orderBy: { position: "asc" },
        select: { templateVersionId: true, fileId: true },
      })
    : [];
  const idsByVersion = new Map<string, string[]>();
  for (const row of versionFiles) {
    idsByVersion.set(row.templateVersionId, [...(idsByVersion.get(row.templateVersionId) ?? []), row.fileId]);
  }

  const imageIdsByMessage = new Map<string, string[]>();
  const allImageIds = new Set<string>();
  for (const message of messages) {
    const ids = message.bodyHtmlSnapshot ? messageFileIdsInHtml(message.bodyHtmlSnapshot) : [];
    if (ids.length > 0) {
      imageIdsByMessage.set(message.id, ids);
      ids.forEach((id) => allImageIds.add(id));
    }
  }
  // Only this event's own inline images are ever linked, whatever a body claims.
  const validImages = allImageIds.size > 0
    ? new Set((await tx.messageFile.findMany({
        where: { id: { in: [...allImageIds] }, eventId: input.eventId, isInlineImage: true },
        select: { id: true },
      })).map((row) => row.id))
    : new Set<string>();

  const data: Prisma.MessageOutboxFileCreateManyInput[] = [];
  for (const message of messages) {
    // An announcement's own files first, then the template version's.
    const attachmentIds = [...new Set([
      ...(input.extraAttachmentFileIds ?? []),
      ...(message.templateVersionId ? idsByVersion.get(message.templateVersionId) ?? [] : []),
    ])];
    attachmentIds.forEach((fileId, position) => {
      data.push({ messageOutboxId: message.id, fileId, disposition: "ATTACHMENT", position });
    });
    (imageIdsByMessage.get(message.id) ?? [])
      .filter((id) => validImages.has(id))
      .forEach((fileId, position) => {
        data.push({ messageOutboxId: message.id, fileId, disposition: "INLINE", position });
      });
  }
  if (data.length > 0) await tx.messageOutboxFile.createMany({ data, skipDuplicates: true });
}

/** The attachment files linked to an announcement's own row, for the send. */
export async function announcementAttachmentIds(client: FileClient, announcementId: string) {
  const rows = await client.announcementFile.findMany({
    where: { announcementId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { fileId: true },
  });
  return rows.map((row) => row.fileId);
}

/** Copies one outbox row's file references to another (a staff retry or resend of the same message). */
export async function copyOutboxFiles(tx: FileClient, fromMessageId: string, toMessageId: string) {
  const rows = await tx.messageOutboxFile.findMany({
    where: { messageOutboxId: fromMessageId },
    select: { fileId: true, disposition: true, position: true },
  });
  if (rows.length === 0) return;
  await tx.messageOutboxFile.createMany({
    data: rows.map((row) => ({ ...row, messageOutboxId: toMessageId })),
    skipDuplicates: true,
  });
}

/** Removes a file nothing refers to any more, from disk and from the table. Safe to call on a file still in use. */
export async function deleteMessageFileIfUnused(eventId: string, fileId: string, client: PrismaClient = getPrisma()) {
  const file = await client.messageFile.findFirst({
    where: {
      id: fileId,
      eventId,
      templateVersions: { none: {} },
      announcements: { none: {} },
      outboxLinks: { none: {} },
    },
    select: { id: true, storageKey: true },
  });
  if (!file) return false;
  let removed: { count: number };
  try {
    removed = await client.messageFile.deleteMany({ where: { id: file.id } });
  } catch {
    // Something linked it between the check and the delete; the database refuses, and the file stays.
    return false;
  }
  if (removed.count === 0) return false;
  await deleteAsset(file.storageKey).catch(() => undefined);
  return true;
}
