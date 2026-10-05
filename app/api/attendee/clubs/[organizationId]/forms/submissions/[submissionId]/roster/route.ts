import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubLeaderViewer } from "@/modules/club-forms/access";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { confirmAddToRoster } from "@/modules/club-forms/roster-add";
import { rosterAddSchema } from "@/modules/club-forms/schemas";

type RouteContext = { params: Promise<{ organizationId: string; submissionId: string }> };

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * A club's director or deputy confirms "Add to roster" for a submitted form
 * (#721): either adds the person they reviewed or links the form to an existing
 * member. The review itself is a page that writes nothing; this is the only
 * write. The viewer comes from the session and the club in the URL, never from
 * the body; a registrar or another club's director is refused.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, submissionId } = await context.params;
    const viewer = await requireClubLeaderViewer(organizationId);
    const input = rosterAddSchema.parse(await readClubFormJson(request));
    const result = await confirmAddToRoster(viewer, { ...input, organizationId, submissionId });
    return Response.json({ result }, { status: 201, headers: privateHeaders });
  } catch (error) {
    return clubFormApiError(error, "Adding a club form to the roster");
  }
}

export const POST = withRequestContext(postHandler);
