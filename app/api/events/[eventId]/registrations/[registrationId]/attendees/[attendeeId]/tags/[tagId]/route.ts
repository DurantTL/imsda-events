import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { TagConfigurationError, removeAttendeeTag } from "@/modules/tags/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof TagConfigurationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "TAG_ASSIGNMENT_REQUEST_FAILED", message: "The tag assignment request could not be completed." }, { status: 500 });
}

async function deleteHandler(request: Request, context: { params: Promise<{ eventId: string; attendeeId: string; tagId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, attendeeId, tagId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const assignment = await removeAttendeeTag(eventId, attendeeId, tagId, access.user.id);
    return Response.json({ assignment });
  } catch (error) { return apiError(error); }
}

export const DELETE = withRequestContext(deleteHandler);
