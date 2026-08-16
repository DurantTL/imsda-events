import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { attendeeTypeInputSchema } from "@/modules/attendee-types/domain";
import { AttendeeConfigurationError, createAttendeeType, listAttendeeConfiguration } from "@/modules/attendee-types/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_ATTENDEE_TYPE", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof AttendeeConfigurationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "ATTENDEE_TYPE_REQUEST_FAILED", message: "The attendee type request could not be completed." }, { status: 500 });
}

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ attendeeTypes: (await listAttendeeConfiguration(eventId)).attendeeTypes });
  } catch (error) { return apiError(error); }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const input = attendeeTypeInputSchema.parse(await request.json());
    return Response.json({ attendeeType: await createAttendeeType(eventId, access.user.id, input) }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
