import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventCloneApiError } from "@/modules/event-clones/api-errors";
import { requireEventClonePermission } from "@/modules/event-clones/authorization";
import { cloneEvent } from "@/modules/event-clones/repository";
import { withRequestContext } from "@/lib/request-context";

/** Confirms a reviewed clone (#157): 201 for the new draft, 200 for an idempotent retry. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventClonePermission(await getCurrentSession());
    const body = await request.json();
    const result = await cloneEvent(user.id, body);
    return Response.json({ event: result.event, alreadyCloned: result.alreadyCloned, summary: result.summary }, { status: result.alreadyCloned ? 200 : 201 });
  } catch (error) {
    return eventCloneApiError(error, {
      failureMessage: "The event could not be copied.",
      logMessage: "Event clone failed",
      invalidInputCode: "INVALID_EVENT_CLONE",
      uniqueViolationIsSlug: true,
    });
  }
}

export const POST = withRequestContext(postHandler);
