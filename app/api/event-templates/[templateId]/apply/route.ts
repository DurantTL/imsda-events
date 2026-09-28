import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventTemplateApiError } from "@/modules/event-templates/api-errors";
import { requireEventTemplateApplyPermission } from "@/modules/event-templates/authorization";
import { applyEventTemplate } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateApplyPermission(await getCurrentSession());
    const { templateId } = await context.params;
    const body = await request.json();
    const result = await applyEventTemplate(templateId, user.id, body);
    return Response.json({ event: result.event, alreadyApplied: result.alreadyApplied }, { status: result.alreadyApplied ? 200 : 201 });
  } catch (error) {
    return eventTemplateApiError(error, {
      failureMessage: "The event could not be created from this template.",
      logMessage: "Event template apply failed",
      invalidInputCode: "INVALID_EVENT_TEMPLATE_APPLICATION",
      referenceStatus: 409,
      uniqueViolationIsSlug: true,
    });
  }
}

export const POST = withRequestContext(postHandler);
