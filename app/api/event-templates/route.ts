import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireEventTemplateManagementPermission } from "@/modules/event-templates/authorization";
import { createEventTemplateInputSchema } from "@/modules/event-templates/domain";
import { EventTemplateOperationError, createEventTemplate, listEventTemplates } from "@/modules/event-templates/repository";
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
  if (error instanceof EventTemplateOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "TEMPLATE_NOT_FOUND" ? 404 : 409 });
  return Response.json({ error: "EVENT_TEMPLATE_REQUEST_FAILED", message: "The event template request could not be completed." }, { status: 500 });
}

async function getHandler() {
  try {
    await requireEventTemplateManagementPermission(await getCurrentSession());
    return Response.json({ templates: await listEventTemplates() });
  } catch (error) { return apiError(error); }
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateManagementPermission(await getCurrentSession());
    const body = createEventTemplateInputSchema.extend({ audience: z.enum(["GENERAL", "CLUB"]).default("GENERAL") }).parse(await request.json());
    const template = await createEventTemplate(user.id, body);
    return Response.json({ template }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
