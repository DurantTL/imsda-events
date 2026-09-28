import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventTemplateApiError } from "@/modules/event-templates/api-errors";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { draftEventTemplateInputSchema } from "@/modules/event-templates/domain";
import { getEventTemplate, saveEventTemplateDraft } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

const errorOptions = { failureMessage: "The event template request could not be completed.", logMessage: "Event template request failed" };

async function getHandler(_request: Request, context: { params: Promise<{ templateId: string }> }) {
  try {
    requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    return Response.json({ template: await getEventTemplate(templateId) });
  } catch (error) { return eventTemplateApiError(error, errorOptions); }
}

async function patchHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    const input = draftEventTemplateInputSchema.parse(await request.json());
    return Response.json({ template: await saveEventTemplateDraft(templateId, user.id, input) });
  } catch (error) { return eventTemplateApiError(error, errorOptions); }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
