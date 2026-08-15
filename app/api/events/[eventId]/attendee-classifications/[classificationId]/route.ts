import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { attendeeClassificationUpdateSchema } from "@/modules/attendee-types/domain";
import { AttendeeConfigurationError, updateAttendeeClassification } from "@/modules/attendee-types/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_ATTENDEE_CLASSIFICATION", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof AttendeeConfigurationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "ATTENDEE_CLASSIFICATION_REQUEST_FAILED", message: "The attendee classification request could not be completed." }, { status: 500 });
}

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; classificationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, classificationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const input = attendeeClassificationUpdateSchema.parse(await request.json());
    return Response.json({ classification: await updateAttendeeClassification(eventId, classificationId, access.user.id, input) });
  } catch (error) { return apiError(error); }
}

export const PATCH = withRequestContext(patchHandler);
