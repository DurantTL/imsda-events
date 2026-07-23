import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { createFormSchema } from "@/modules/forms/definition";
import { createRegistrationForm, FormOperationError, listFormTemplates, listRegistrationForms } from "@/modules/forms/repository";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_FORM", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof FormOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code.endsWith("NOT_FOUND") ? 404 : 409 });
  console.error("Registration form request failed", error);
  return Response.json({ error: "FORM_REQUEST_FAILED", message: "The registration form request could not be completed." }, { status: 500 });
}

export async function GET(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    return Response.json({ forms: await listRegistrationForms(eventId), templates: listFormTemplates() });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    const input = createFormSchema.parse(await request.json());
    return Response.json({ form: await createRegistrationForm(eventId, access.user.id, input.templateKey) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
