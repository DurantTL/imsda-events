import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { TagConfigurationError, updateTag } from "@/modules/tags/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_TAG", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof TagConfigurationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "TAG_REQUEST_FAILED", message: "The tag request could not be completed." }, { status: 500 });
}

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; tagId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, tagId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const tag = await updateTag(eventId, tagId, access.user.id, await request.json());
    return Response.json({ tag });
  } catch (error) { return apiError(error); }
}

export const PATCH = withRequestContext(patchHandler);
