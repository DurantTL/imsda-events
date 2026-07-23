import { getPrisma } from "@/lib/prisma";

export async function listAnnouncements(eventId: string) {
  const rows = await getPrisma().announcement.findMany({
    where: { eventId },
    orderBy: [{ status: "desc" }, { updatedAt: "desc" }],
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
