import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { updateClubProfile } from "@/modules/organizations/club-profile-repository";
import { clubProfileInputSchema } from "@/modules/organizations/club-profile-schemas";
import { withRequestContext } from "@/lib/request-context";

/** The club's director or deputy saves the club profile (#375). Audited. */
async function patchHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "editProfile");
    const input = clubProfileInputSchema.parse(await request.json());
    return Response.json({ profile: await updateClubProfile(organizationId, input, actorAttribution(access.actor)) });
  } catch (error) {
    return rosterApiError(error, "Saving the club profile");
  }
}

export const PATCH = withRequestContext(patchHandler);
