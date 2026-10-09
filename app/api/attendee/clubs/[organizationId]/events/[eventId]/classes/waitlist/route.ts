import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { joinClassWaitlist } from "@/modules/honors/waitlist-repository";
import { withRequestContext } from "@/lib/request-context";

const joinSchema = z.object({
  attendeeId: z.string().min(1).max(64),
  offeringId: z.string().min(1).max(64),
  /** The director confirms the youth meets a missing class level or honor record (#832). */
  confirmed: z.boolean().optional(),
  /** Staff acting as the director only (#832). */
  overrideReason: z.string().trim().min(3, "Give a reason for placing someone who doesn't meet a class requirement.").max(300).optional(),
}).strict();

/** Puts a youth on a full class's waitlist (#831). It takes no seat; the server checks every rule. */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const input = joinSchema.parse(await request.json());
    const workspace = await joinClassWaitlist(organizationId, eventId, actorAttribution(access.actor), input);
    return Response.json({ workspace }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Joining a class waitlist");
  }
}

export const POST = withRequestContext(postHandler);
