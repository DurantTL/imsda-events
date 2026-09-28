import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireEventTemplateApplyPermission } from "@/modules/event-templates/authorization";
import { EventTemplateReferenceError } from "@/modules/event-templates/domain";
import { EventTemplateOperationError, applyEventTemplate } from "@/modules/event-templates/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: "INVALID_EVENT_TEMPLATE_APPLICATION",
      message: error.issues[0]?.message ?? "Review the new event's details and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventTemplateReferenceError) {
    return Response.json({ error: "TEMPLATE_REFERENCES_INVALID", message: error.message, issues: error.issues }, { status: 409 });
  }
  if (error instanceof EventTemplateOperationError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.code === "TEMPLATE_NOT_FOUND" ? 404 : 409 });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return Response.json({
      error: "EVENT_SLUG_TAKEN",
      message: "That event web address is already in use. Choose another short address.",
    }, { status: 409 });
  }
  return Response.json({ error: "EVENT_TEMPLATE_REQUEST_FAILED", message: "The event could not be created from this template." }, { status: 500 });
}

async function postHandler(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventTemplateApplyPermission(await getCurrentSession());
    const { templateId } = await context.params;
    const body = await request.json();
    const result = await applyEventTemplate(templateId, user.id, body);
    return Response.json({ event: result.event, alreadyApplied: result.alreadyApplied }, { status: result.alreadyApplied ? 200 : 201 });
  } catch (error) { return apiError(error); }
}

export const POST = withRequestContext(postHandler);
