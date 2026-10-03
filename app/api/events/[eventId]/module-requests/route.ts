import { z } from "zod";
import { AccessDeniedError, requireAuthenticatedUser } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { moduleRequestSchema } from "@/modules/event-modules/request-domain";
import { createModuleRequest, ModuleRequestError } from "@/modules/event-modules/requests";
import { EventModuleError } from "@/modules/event-modules/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkModuleRequestRateLimit } from "@/modules/rate-limit/service";

/**
 * Ask for an event module to be turned on (#741 slice 3). Event admins of the
 * event only: the service checks the membership, so this route cannot widen
 * access. Same-origin only and rate limited, because each request emails the
 * conference office.
 */

type RouteContext = { params: Promise<{ eventId: string }> };

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "INVALID_MODULE_REQUEST", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventModuleError) {
    const status = error.code === "EVENT_NOT_FOUND" || error.code === "UNKNOWN_MODULE" ? 404 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof ModuleRequestError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.code === "INVALID_REASON" ? 400 : error.code === "SYSTEM_ADMIN_ENABLES_DIRECTLY" ? 403 : 409 });
  }
  logError("Module request failed", error);
  return Response.json({ error: "MODULE_REQUEST_FAILED", message: "The request could not be sent." }, { status: 500 });
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const session = await getCurrentSession();
    const user = requireAuthenticatedUser(session);
    const rateLimit = await checkModuleRequestRateLimit(request, user.id);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        Response.json({ error: "RATE_LIMITED", message: "Too many requests. Try again later." }, { status: 429 }),
        rateLimit,
      );
    }
    const input = moduleRequestSchema.parse(await request.json().catch(() => ({})));
    const created = await createModuleRequest(user, eventId, input.moduleKey, input.reason);
    return Response.json({ id: created.id, status: "PENDING" }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withRequestContext(postHandler);
