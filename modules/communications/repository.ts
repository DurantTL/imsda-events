import { getPrisma } from "@/lib/prisma";

export async function listAnnouncements(eventId: string) {
  const rows = await getPrisma().announcement.findMany({
    where: { eventId },
    orderBy: [{ status: "desc" }, { pinnedAt: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map((row) => ({
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
  }));
}

export async function createAnnouncement(
  eventId: string,
  createdByUserId: string,
  input: { title: string; body: string; priority: "NORMAL" | "IMPORTANT" | "URGENT" },
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
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId: createdByUserId,
        action: "ANNOUNCEMENT_CREATED",
        entityType: "Announcement",
        entityId: announcement.id,
        correlationId: crypto.randomUUID(),
        summary: `Created announcement draft: ${input.title}.`,
      },
    });
    return announcement;
  });
}

export async function publishAnnouncement(eventId: string, announcementId: string, actorUserId: string) {
  const prisma = getPrisma();
  const existing = await prisma.announcement.findFirst({ where: { id: announcementId, eventId } });
  if (!existing) return null;
  return prisma.$transaction(async (tx) => {
    const announcement = await tx.announcement.update({
      where: { id: announcementId },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
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
    return announcement;
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
  input: { title: string; body: string; priority: "NORMAL" | "IMPORTANT" | "URGENT" },
) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id: announcementId, eventId, status: "DRAFT" },
      select: { id: true, title: true },
    });
    if (!existing) return null;
    const announcement = await tx.announcement.update({
      where: { id: existing.id },
      data: { title: input.title, body: input.body, priority: input.priority },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "ANNOUNCEMENT_DRAFT_EDITED",
        entityType: "Announcement",
        entityId: announcement.id,
        correlationId: crypto.randomUUID(),
        summary: `Edited announcement draft: ${input.title}.`,
        metadata: { previousTitle: existing.title },
      },
    });
    return announcement;
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
