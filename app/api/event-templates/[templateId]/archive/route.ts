import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventTemplateApiError } from "@/modules/event-templates/api-errors";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { archiveEventTemplate } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    return Response.json({ template: await archiveEventTemplate(templateId, user.id) });
  } catch (error) {
    return eventTemplateApiError(error, { failureMessage: "The event template could not be archived.", logMessage: "Event template archive failed" });
  }
}

export const POST = withRequestContext(postHandler);
