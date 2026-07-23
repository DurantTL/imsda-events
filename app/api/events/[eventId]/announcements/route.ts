import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { createAnnouncement, listAnnouncements } from "@/modules/communications/repository";
import { findActiveMembership } from "@/modules/events/repository";

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(5).max(2000),
  priority: z.enum(["NORMAL", "IMPORTANT", "URGENT"]).default("NORMAL"),
});

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_ANNOUNCEMENT", issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  console.error("Announcement request failed", error);
  return Response.json({ error: "ANNOUNCEMENT_REQUEST_FAILED" }, { status: 500 });
}

export async function GET(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "VIEW_EVENT", findActiveMembership);
    return Response.json({ announcements: await listAnnouncements(eventId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_COMMUNICATIONS", findActiveMembership);
    const input = announcementSchema.parse(await request.json());
    const announcement = await createAnnouncement(eventId, access.user.id, input);
    return Response.json({ announcement }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
