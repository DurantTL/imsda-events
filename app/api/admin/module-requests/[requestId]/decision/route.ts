import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { moduleRequestDecisionSchema } from "@/modules/event-modules/request-domain";
import { decideModuleRequest, ModuleRequestError } from "@/modules/event-modules/requests";
import { EventModuleError } from "@/modules/event-modules/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Approve or decline a module request (#741 slice 3). System administrators
 * only: the service refuses anyone else. Approving turns the module on in the
 * same transaction; declining needs a reason.
 */

type RouteContext = { params: Promise<{ requestId: string }> };

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "INVALID_DECISION", message: error.issues[0]?.message ?? "Check the decision and try again." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventModuleError) {
    const status = error.code === "EVENT_NOT_FOUND" || error.code === "UNKNOWN_MODULE" ? 404 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof ModuleRequestError) {
    const status = error.code === "REQUEST_NOT_FOUND" ? 404 : error.code === "INVALID_REASON" ? 400 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  logError("Module request decision failed", error);
  return Response.json({ error: "MODULE_REQUEST_DECISION_FAILED", message: "The decision could not be saved." }, { status: 500 });
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { requestId } = await context.params;
    const { user } = await getCurrentSession();
    // Authorize before reading the body, so a non-admin learns nothing about the shape.
    if (!user) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
    if (user.globalRole !== "SYSTEM_ADMIN") {
      throw new AccessDeniedError("Only a system administrator can approve or decline a feature request.", 403, "PERMISSION_DENIED");
    }
    const input = moduleRequestDecisionSchema.parse(await request.json().catch(() => ({})));
    const result = await decideModuleRequest(user, requestId, input);
    return Response.json({ id: requestId, status: result.status });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withRequestContext(postHandler);
