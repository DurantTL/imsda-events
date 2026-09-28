import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { updateFormSlugSchema } from "@/modules/forms/definition";
import { FormOperationError, suggestRegistrationFormSlug, updateRegistrationFormSlug } from "@/modules/forms/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_FORM", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof FormOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "FORM_NOT_FOUND" ? 404 : 409 });
  logError("Registration form slug update failed", error);
  return Response.json({ error: "FORM_REQUEST_FAILED", message: "The web address could not be updated." }, { status: 500 });
}

/** The address the builder should offer before a first publish (#476). */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  try {
    const { eventId, formId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    return Response.json({ suggestion: await suggestRegistrationFormSlug(eventId, formId) });
  } catch (error) { return apiError(error); }
}

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, formId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    const input = updateFormSlugSchema.parse(await request.json());
    return Response.json({ form: await updateRegistrationFormSlug(eventId, formId, access.user.id, input.slug) });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
