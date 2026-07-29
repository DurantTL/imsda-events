import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  AnnouncementBroadcastError,
  broadcastPublishedAnnouncement,
} from "@/modules/communications/announcement-broadcast";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

const inputSchema = z.strictObject({ batchId: z.uuid() });
type Context = {
  params: Promise<{ eventId: string; announcementId: string }>;
};

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
    const input = inputSchema.parse(await request.json());
    const result = await broadcastPublishedAnnouncement({
      eventId,
      announcementId,
      batchId: input.batchId,
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
        { error: "INVALID_REQUEST", message: "A valid broadcast batch ID is required." },
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
