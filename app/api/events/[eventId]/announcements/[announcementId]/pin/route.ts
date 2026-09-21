import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { setAnnouncementPinned } from "@/modules/communications/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const pinSchema = z.object({ pinned: z.boolean() });

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; announcementId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, announcementId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_COMMUNICATIONS", findActiveMembership);
    const { pinned } = pinSchema.parse(await request.json());
    const announcement = await setAnnouncementPinned(eventId, announcementId, access.user.id, pinned);
    if (!announcement) return Response.json({ error: "ANNOUNCEMENT_NOT_FOUND" }, { status: 404 });
    return Response.json({ announcement: {
      ...announcement,
      publishedAt: announcement.publishedAt?.toISOString() ?? null,
      pinnedAt: announcement.pinnedAt?.toISOString() ?? null,
      updatedAt: announcement.updatedAt.toISOString(),
    } });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_PIN_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Announcement pin request failed", error);
    return Response.json({ error: "ANNOUNCEMENT_PIN_REQUEST_FAILED" }, { status: 500 });
  }
}

export const PATCH = withRequestContext(patchHandler);
