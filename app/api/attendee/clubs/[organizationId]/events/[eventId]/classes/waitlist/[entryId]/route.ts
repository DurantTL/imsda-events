import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { leaveClassWaitlist } from "@/modules/honors/waitlist-repository";
import { withRequestContext } from "@/lib/request-context";

/** Takes a youth off a class waitlist, or declines the seat offered to them so it passes to the next youth (#831). */
async function deleteHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string; entryId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId, entryId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const workspace = await leaveClassWaitlist(organizationId, eventId, actorAttribution(access.actor), entryId);
    return Response.json({ workspace }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Leaving a class waitlist");
  }
}

export const DELETE = withRequestContext(deleteHandler);
