import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  listEventContentSections,
  replaceEventContent,
} from "@/modules/events/content-repository";
import { eventContentInputSchema } from "@/modules/events/content-schemas";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string }> };

function apiError(error: unknown, operation: string) {
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: "INVALID_EVENT_CONTENT",
        message: error.issues[0]?.message ?? "Review the sections and try again.",
        issues: error.issues,
      },
      { status: 400 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "INVALID_JSON", message: "The request is not valid JSON." },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  logError(`${operation} failed`, error);
  return Response.json(
    { error: "EVENT_CONTENT_FAILED", message: `${operation} could not be completed.` },
    { status: 500 },
  );
}

async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { eventId } = await context.params;
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "CONFIGURE_EVENT",
      findActiveMembership,
    );
    return Response.json({ sections: await listEventContentSections(eventId) });
  } catch (error) {
    return apiError(error, "Loading the event page content");
  }
}

async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "CONFIGURE_EVENT",
      findActiveMembership,
    );
    const input = eventContentInputSchema.parse(await request.json());
    const sections = await replaceEventContent(eventId, input, access.user.id);
    return Response.json({ sections });
  } catch (error) {
    return apiError(error, "Saving the event page content");
  }
}

export const GET = withRequestContext(getHandler);
export const PUT = withRequestContext(putHandler);
