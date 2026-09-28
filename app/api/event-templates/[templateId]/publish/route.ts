import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { EventTemplateReferenceError } from "@/modules/event-templates/domain";
import { EventTemplateOperationError, publishEventTemplateVersion } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventTemplateReferenceError) {
    return Response.json({ error: "TEMPLATE_REFERENCES_INVALID", message: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof EventTemplateOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "TEMPLATE_NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "EVENT_TEMPLATE_REQUEST_FAILED", message: "The event template could not be published." }, { status: 500 });
}

async function postHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const { templateId } = await context.params;
    return Response.json({ template: await publishEventTemplateVersion(templateId, user.id) });
  } catch (error) { return apiError(error); }
}

export const POST = withRequestContext(postHandler);
