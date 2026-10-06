import { z } from "zod";
import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubTeamApiError } from "@/modules/club-teams/api-errors";
import { getTeamSettings, saveTeamSettings } from "@/modules/club-teams/settings-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string }> };

const noStore = { "Cache-Control": "no-store" };

/** The event's team rules (#809), for event administrators (CONFIGURE_EVENT). */
async function getHandler(_request: Request, context: Context) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ teamSettings: await getTeamSettings(eventId) }, { headers: noStore });
  } catch (error) {
    return clubTeamApiError(error, "Loading the team rules");
  }
}

/** Sets the event's team rules (#809). Audited; refused where it would strand existing registrations. */
async function putHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const teamSettings = await saveTeamSettings(eventId, access.user.id, await request.json());
    return Response.json({ teamSettings }, { headers: noStore });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "INVALID_TEAM_SETTINGS", message: error.issues[0]?.message ?? "Review the team rules.", issues: error.issues },
        { status: 400, headers: noStore },
      );
    }
    return clubTeamApiError(error, "Saving the team rules");
  }
}

export const GET = withRequestContext(getHandler);
export const PUT = withRequestContext(putHandler);
