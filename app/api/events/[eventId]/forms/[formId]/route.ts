import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { updateFormSchema } from "@/modules/forms/definition";
import { FormOperationError, getRegistrationForm, updateRegistrationForm } from "@/modules/forms/repository";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_FORM", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof FormOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "FORM_NOT_FOUND" ? 404 : 409 });
  console.error("Registration form detail request failed", error);
  return Response.json({ error: "FORM_REQUEST_FAILED", message: "The registration form request could not be completed." }, { status: 500 });
}

export async function GET(_request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  try {
    const { eventId, formId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    const form = await getRegistrationForm(eventId, formId);
    if (!form) return Response.json({ error: "FORM_NOT_FOUND", message: "That registration form was not found." }, { status: 404 });
    return Response.json({ form });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, formId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    const input = updateFormSchema.parse(await request.json());
    return Response.json({ form: await updateRegistrationForm(eventId, formId, access.user.id, input) });
  } catch (error) { return apiError(error); }
}
