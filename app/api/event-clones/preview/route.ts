import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventCloneApiError } from "@/modules/event-clones/api-errors";
import { requireEventClonePermission } from "@/modules/event-clones/authorization";
import { previewEventClone } from "@/modules/event-clones/repository";
import { withRequestContext } from "@/lib/request-context";

/** Previews cloning one event (#157). A POST because it is audited. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventClonePermission(await getCurrentSession());
    const body = await request.json();
    return Response.json({ plan: await previewEventClone(user.id, body) });
  } catch (error) {
    return eventCloneApiError(error, {
      failureMessage: "The copy plan could not be prepared.",
      logMessage: "Event clone preview failed",
      invalidInputCode: "INVALID_EVENT_CLONE_PREVIEW",
    });
  }
}

export const POST = withRequestContext(postHandler);
