import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { draftEventTemplateInputSchema } from "@/modules/event-templates/domain";
import { EventTemplateOperationError, getEventTemplate, saveEventTemplateDraft } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: "INVALID_EVENT_TEMPLATE",
      message: error.issues[0]?.message ?? "Review the template details and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventTemplateOperationError) {
    return Response.json({ error: error.code, message: error.message }, {
      status: error.code === "TEMPLATE_NOT_FOUND" ? 404 : error.code === "EDIT_CONFLICT" ? 409 : 400,
    });
  }
  return Response.json({ error: "EVENT_TEMPLATE_REQUEST_FAILED", message: "The event template request could not be completed." }, { status: 500 });
}

async function getHandler(_request: Request, context: { params: Promise<{ templateId: string }> }) {
  try {
    await requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    return Response.json({ template: await getEventTemplate(templateId) });
  } catch (error) { return apiError(error); }
}

async function patchHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    const input = draftEventTemplateInputSchema.parse(await request.json());
    return Response.json({ template: await saveEventTemplateDraft(templateId, user.id, input) });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
