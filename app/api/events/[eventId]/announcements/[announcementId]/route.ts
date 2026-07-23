import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { publishAnnouncement } from "@/modules/communications/repository";
import { findActiveMembership } from "@/modules/events/repository";

export async function PATCH(request: Request, context: { params: Promise<{ eventId: string; announcementId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, announcementId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_COMMUNICATIONS", findActiveMembership);
    const announcement = await publishAnnouncement(eventId, announcementId, access.user.id);
    return announcement ? Response.json({ announcement }) : Response.json({ error: "ANNOUNCEMENT_NOT_FOUND" }, { status: 404 });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("Announcement publish failed", error);
    return Response.json({ error: "ANNOUNCEMENT_PUBLISH_FAILED" }, { status: 500 });
  }
}
