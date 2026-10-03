import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { disableModule, enableModule, EventModuleError } from "@/modules/event-modules/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Turn an event module on (PUT) or off (DELETE) (#741 slice 2). System
 * administrators only: the service refuses anyone else, so this route cannot be
 * used to widen access. A module is a relevance switch; turning it off removes
 * the switch and never deletes the data behind it. Both directions are audited
 * by the service.
 */

type RouteContext = { params: Promise<{ eventId: string; moduleKey: string }> };

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventModuleError) {
    const status = error.code === "EVENT_NOT_FOUND" || error.code === "UNKNOWN_MODULE" ? 404 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  logError("Event module change failed", error);
  return Response.json({ error: "EVENT_MODULE_CHANGE_FAILED", message: "The module could not be changed." }, { status: 500 });
}

async function change(request: Request, context: RouteContext, enabled: boolean) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, moduleKey } = await context.params;
    const { user } = await getCurrentSession();
    const result = enabled ? await enableModule(user, eventId, moduleKey) : await disableModule(user, eventId, moduleKey);
    return Response.json({ moduleKey, enabled, changed: result.changed });
  } catch (error) {
    return apiError(error);
  }
}

async function putHandler(request: Request, context: RouteContext) {
  return change(request, context, true);
}

async function deleteHandler(request: Request, context: RouteContext) {
  return change(request, context, false);
}

export const PUT = withRequestContext(putHandler);
export const DELETE = withRequestContext(deleteHandler);
