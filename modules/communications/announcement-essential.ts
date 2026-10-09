import { getPrisma } from "@/lib/prisma";

/**
 * Marks an announcement essential, or clears it (#838). An essential announcement reaches people who opted out of
 * announcements, so the route that calls this requires an event manager or above, and every change is audited with
 * who made it. Delivery reads the mark when each message is sent, so a change applies to messages still queued (and to their retry copies) but never to mail already sent.
 */
export async function setAnnouncementEssential(
  eventId: string,
  announcementId: string,
  actorUserId: string,
  essential: boolean,
) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id: announcementId, eventId },
      select: { id: true, title: true, isEssential: true },
    });
    if (!existing) return null;
    if (existing.isEssential === essential) {
      return { id: existing.id, isEssential: essential, changed: false as const };
    }
    await tx.announcement.update({ where: { id: existing.id }, data: { isEssential: essential } });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: essential ? "ANNOUNCEMENT_MARKED_ESSENTIAL" : "ANNOUNCEMENT_ESSENTIAL_CLEARED",
        entityType: "Announcement",
        entityId: existing.id,
        correlationId: crypto.randomUUID(),
        summary: essential
          ? `Marked announcement essential, so it reaches people who opted out: ${existing.title}.`
          : `Cleared the essential mark on announcement: ${existing.title}.`,
        metadata: { previouslyEssential: existing.isEssential },
      },
    });
    return { id: existing.id, isEssential: essential, changed: true as const };
  });
}
