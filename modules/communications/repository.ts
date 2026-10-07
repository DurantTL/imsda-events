import { getPrisma } from "@/lib/prisma";
import { describeFilesForAudit, listAnnouncementFiles, setAnnouncementFiles } from "@/modules/communications/message-files";
import type { MessageFileRecord } from "@/modules/communications/message-file-rules";

type AnnouncementRow = Awaited<ReturnType<ReturnType<typeof getPrisma>["announcement"]["findMany"]>>[number];

/** The client-facing shape: no internal user IDs. */
function toAnnouncementRecord(row: AnnouncementRow, attachments: MessageFileRecord[] = []) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    placement: row.placement,
    audience: row.audience,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    attachments,
  };
}

export async function listAnnouncements(eventId: string) {
  const prisma = getPrisma();
  const rows = await prisma.announcement.findMany({
    where: { eventId },
    orderBy: [{ status: "desc" }, { pinnedAt: "desc" }, { updatedAt: "desc" }],
  });
  const files = await listAnnouncementFiles(prisma, rows.map((row) => row.id));
  return rows.map((row) => toAnnouncementRecord(row, files.get(row.id) ?? []));
}

export async function createAnnouncement(
  eventId: string,
  createdByUserId: string,
  input: { title: string; body: string; priority: "NORMAL" | "IMPORTANT" | "URGENT"; attachmentFileIds?: string[] },
) {
  return getPrisma().$transaction(async (tx) => {
    const announcement = await tx.announcement.create({
      data: {
        eventId,
        createdByUserId,
        title: input.title,
        body: input.body,
        priority: input.priority,
        audience: { type: "ALL_ATTENDEES" },
        placement: "HOME_BANNER",
        status: "DRAFT",
      },
    });
    const fileIds = await setAnnouncementFiles(tx, eventId, announcement.id, input.attachmentFileIds ?? []);
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId: createdByUserId,
        action: "ANNOUNCEMENT_CREATED",
        entityType: "Announcement",
        entityId: announcement.id,
        correlationId: crypto.randomUUID(),
        summary: `Created announcement draft: ${input.title}.`,
        // File names and sizes only (#824).
        metadata: { attachments: await describeFilesForAudit(tx, fileIds) },
      },
    });
    return toAnnouncementRecord(announcement, (await listAnnouncementFiles(tx, [announcement.id])).get(announcement.id) ?? []);
  });
}

/**
 * Publishes a draft. Only a DRAFT can be published: an already-published or
 * discarded announcement returns null and is left untouched (`publishedAt` is
 * never reset).
 */
export async function publishAnnouncement(eventId: string, announcementId: string, actorUserId: string) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id: announcementId, eventId, status: "DRAFT" },
      select: { id: true, title: true },
    });
    if (!existing) return null;
    const updated = await tx.announcement.updateMany({
      where: { id: announcementId, eventId, status: "DRAFT" },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    if (updated.count === 0) return null;
    const announcement = await tx.announcement.findFirst({ where: { id: announcementId, eventId } });
    if (!announcement) return null;
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "ANNOUNCEMENT_PUBLISHED",
        entityType: "Announcement",
        entityId: announcementId,
        correlationId: crypto.randomUUID(),
        summary: `Published announcement: ${existing.title}.`,
      },
    });
    return toAnnouncementRecord(announcement, (await listAnnouncementFiles(tx, [announcement.id])).get(announcement.id) ?? []);
  });
}

/**
 * Edit a draft's text (#571 F-9). Only drafts can be edited; nothing is
 * published or sent. Returns null when the draft is missing or already
 * published.
 */
export async function updateAnnouncementDraft(
  eventId: string,
  announcementId: string,
  actorUserId: string,
  input: { title: string; body: string; priority: "NORMAL" | "IMPORTANT" | "URGENT"; attachmentFileIds?: string[] },
) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id: announcementId, eventId, status: "DRAFT" },
      select: { id: true, title: true },
    });
    if (!existing) return null;
    const updated = await tx.announcement.updateMany({
      where: { id: existing.id, eventId, status: "DRAFT" },
      data: { title: input.title, body: input.body, priority: input.priority },
    });
    if (updated.count === 0) return null;
    const announcement = await tx.announcement.findFirst({ where: { id: existing.id, eventId } });
    if (!announcement) return null;
    // Only a draft's attachments change; a published announcement's files are what was reviewed and sent.
    if (input.attachmentFileIds) await setAnnouncementFiles(tx, eventId, existing.id, input.attachmentFileIds);
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "ANNOUNCEMENT_DRAFT_EDITED",
        entityType: "Announcement",
        entityId: announcement.id,
        correlationId: crypto.randomUUID(),
        summary: `Edited announcement draft: ${input.title}.`,
        metadata: {
          previousTitle: existing.title,
          // File names and sizes only (#824).
          attachments: await describeFilesForAudit(tx, (await listAnnouncementFiles(tx, [announcement.id])).get(announcement.id)?.map((file) => file.id) ?? []),
        },
      },
    });
    return toAnnouncementRecord(announcement, (await listAnnouncementFiles(tx, [announcement.id])).get(announcement.id) ?? []);
  });
}

/**
 * Discard a draft (#571 F-9). The row is deleted with an audit entry; only
 * drafts can be discarded, so nothing that reached attendees is removed.
 */
export async function discardAnnouncementDraft(eventId: string, announcementId: string, actorUserId: string) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id: announcementId, eventId, status: "DRAFT" },
      select: { id: true, title: true },
    });
    if (!existing) return false;
    const deleted = await tx.announcement.deleteMany({
      where: { id: existing.id, eventId, status: "DRAFT" },
    });
    if (deleted.count === 0) return false;
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "ANNOUNCEMENT_DRAFT_DISCARDED",
        entityType: "Announcement",
        entityId: existing.id,
        correlationId: crypto.randomUUID(),
        summary: `Discarded announcement draft: ${existing.title}.`,
      },
    });
    return true;
  });
}

/** Pinning is limited to published official updates and records who changed it. */
export async function setAnnouncementPinned(
  eventId: string,
  announcementId: string,
  actorUserId: string,
  pinned: boolean,
) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id: announcementId, eventId, status: "PUBLISHED" },
      select: { id: true, title: true, pinnedAt: true },
    });
    if (!existing) return null;
    const announcement = await tx.announcement.update({
      where: { id: existing.id },
      data: pinned
        ? { pinnedAt: new Date(), pinnedByUserId: actorUserId }
        : { pinnedAt: null, pinnedByUserId: null },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: pinned ? "ANNOUNCEMENT_PINNED" : "ANNOUNCEMENT_UNPINNED",
        entityType: "Announcement",
        entityId: announcement.id,
        correlationId: crypto.randomUUID(),
        summary: `${pinned ? "Pinned" : "Unpinned"} official announcement: ${announcement.title}.`,
        metadata: { previousPinnedAt: existing.pinnedAt?.toISOString() ?? null },
      },
    });
    return announcement;
  });
}
