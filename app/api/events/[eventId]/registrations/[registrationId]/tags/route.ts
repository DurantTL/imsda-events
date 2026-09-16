import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { TagConfigurationError, applyRegistrationTag, listRegistrationTagAssignments } from "@/modules/tags/repository";
import { withRequestContext } from "@/lib/request-context";

const applySchema = z.object({ tagId: z.string().min(1) });

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_TAG_ASSIGNMENT", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof TagConfigurationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "TAG_ASSIGNMENT_REQUEST_FAILED", message: "The tag assignment request could not be completed." }, { status: 500 });
}

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  try {
    const { eventId, registrationId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "VIEW_SENSITIVE_DATA", findActiveMembership);
    return Response.json({ assignments: await listRegistrationTagAssignments(eventId, registrationId) });
  } catch (error) { return apiError(error); }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const { tagId } = applySchema.parse(await request.json());
    const assignment = await applyRegistrationTag(eventId, registrationId, tagId, access.user.id);
    return Response.json({ assignment }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
