import { z } from "zod";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventTemplateApiError } from "@/modules/event-templates/api-errors";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { createEventTemplateInputSchema } from "@/modules/event-templates/domain";
import { createEventTemplate, listEventTemplates } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

const errorOptions = { failureMessage: "The event template request could not be completed.", logMessage: "Event template request failed" };

async function getHandler() {
  try {
    requireEventTemplateManagementPermission(await getCurrentSession());
    return Response.json({ templates: await listEventTemplates() });
  } catch (error) { return eventTemplateApiError(error, errorOptions); }
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const body = createEventTemplateInputSchema.extend({ audience: z.enum(["GENERAL", "CLUB"]).default("GENERAL") }).parse(await request.json());
    const template = await createEventTemplate(user.id, body);
    return Response.json({ template }, { status: 201 });
  } catch (error) { return eventTemplateApiError(error, errorOptions); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
