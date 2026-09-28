import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventTemplateApiError } from "@/modules/event-templates/api-errors";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { addStarterEventTemplates } from "@/modules/event-templates/starter-repository";
import { withRequestContext } from "@/lib/request-context";

const errorOptions = { failureMessage: "The starter templates could not be added.", logMessage: "Adding starter event templates failed" };

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    return Response.json(await addStarterEventTemplates(user.id));
  } catch (error) { return eventTemplateApiError(error, errorOptions); }
}

export const POST = withRequestContext(postHandler);
