import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  AnnouncementBroadcastError,
  broadcastPublishedAnnouncement,
  previewAnnouncementBroadcast,
} from "@/modules/communications/announcement-broadcast";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

const inputSchema = z.strictObject({
  batchId: z.uuid(),
  // Optional at the schema so a missing fingerprint gets the review-specific
  // 409 below rather than a generic 400.
  previewFingerprint: z.string().trim().max(128).optional(),
});
type Context = {
  params: Promise<{ eventId: string; announcementId: string }>;
};

/**
 * A review step, not an extra confirmation click: preview is a POST because
 * `mode` and the send fields share one endpoint (matching the
 * selected-audience-messages route's own preview/send split), and it never
 * enqueues a message or writes an audit row — only the send below does that.
 * The send must echo the preview's fingerprint; a missing or stale one is
 * refused with 409 so an unreviewed or out-of-date audience never goes out.
 */
async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, announcementId } = await context.params;
    const session = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const body = await request.json();
    if (body?.mode === "preview") {
      const preview = await previewAnnouncementBroadcast({ eventId, announcementId });
      return Response.json({ preview });
    }
    const input = inputSchema.parse(body);
    if (!input.previewFingerprint) {
      return Response.json(
        {
          error: "PREVIEW_REQUIRED",
          message: "Review the recipients before sending this announcement.",
        },
        { status: 409 },
      );
    }
    const result = await broadcastPublishedAnnouncement({
      eventId,
      announcementId,
      batchId: input.batchId,
      previewFingerprint: input.previewFingerprint,
      actorUserId: session.user.id,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "INVALID_REQUEST", message: "A valid broadcast batch ID and review fingerprint are required." },
        { status: 400 },
      );
    }
    if (error instanceof AnnouncementBroadcastError) {
      const status = error.code === "ANNOUNCEMENT_NOT_FOUND" ? 404 : 409;
      return Response.json(
        { error: error.code, message: error.message },
        { status },
      );
    }
    throw error;
  }
}

export const POST = withRequestContext(postHandler);
