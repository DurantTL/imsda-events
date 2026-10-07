import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { z } from "zod";
import { MessageFileError } from "@/modules/communications/message-files";
import { discardAnnouncementDraft, publishAnnouncement, updateAnnouncementDraft } from "@/modules/communications/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const draftSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(5).max(2000),
  priority: z.enum(["NORMAL", "IMPORTANT", "URGENT"]).default("NORMAL"),
  attachmentFileIds: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
});

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; announcementId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, announcementId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_COMMUNICATIONS", findActiveMembership);
    const announcement = await publishAnnouncement(eventId, announcementId, access.user.id);
    return announcement ? Response.json({ announcement }) : Response.json({ error: "DRAFT_NOT_FOUND", message: "That draft no longer exists or was already published." }, { status: 404 });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Announcement publish failed", error);
    return Response.json({ error: "ANNOUNCEMENT_PUBLISH_FAILED" }, { status: 500 });
  }
}

/** Edit a draft's text (#571). Never publishes or sends. */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string; announcementId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, announcementId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_COMMUNICATIONS", findActiveMembership);
    const input = draftSchema.parse(await request.json());
    const announcement = await updateAnnouncementDraft(eventId, announcementId, access.user.id, input);
    return announcement ? Response.json({ announcement }) : Response.json({ error: "DRAFT_NOT_FOUND", message: "That draft no longer exists or was already published." }, { status: 404 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_ANNOUNCEMENT", issues: error.issues }, { status: 400 });
    if (error instanceof MessageFileError) return Response.json({ error: error.code, message: error.message }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Announcement draft edit failed", error);
    return Response.json({ error: "ANNOUNCEMENT_UPDATE_FAILED" }, { status: 500 });
  }
}

/** Discard a draft (#571). Published announcements are never deleted. */
async function deleteHandler(request: Request, context: { params: Promise<{ eventId: string; announcementId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, announcementId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_COMMUNICATIONS", findActiveMembership);
    const discarded = await discardAnnouncementDraft(eventId, announcementId, access.user.id);
    return discarded ? Response.json({ discarded: true }) : Response.json({ error: "DRAFT_NOT_FOUND", message: "That draft no longer exists or was already published." }, { status: 404 });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Announcement draft discard failed", error);
    return Response.json({ error: "ANNOUNCEMENT_DISCARD_FAILED" }, { status: 500 });
  }
}

export const PUT = withRequestContext(putHandler);
export const DELETE = withRequestContext(deleteHandler);
export const PATCH = withRequestContext(patchHandler);
