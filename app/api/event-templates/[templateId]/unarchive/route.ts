import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventTemplateApiError } from "@/modules/event-templates/api-errors";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { unarchiveEventTemplate } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    return Response.json({ template: await unarchiveEventTemplate(templateId, user.id) });
  } catch (error) {
    return eventTemplateApiError(error, { failureMessage: "The event template could not be unarchived.", logMessage: "Event template unarchive failed" });
  }
}

export const POST = withRequestContext(postHandler);
