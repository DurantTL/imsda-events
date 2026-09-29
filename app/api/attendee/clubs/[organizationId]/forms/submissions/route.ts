import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubLeaderViewer } from "@/modules/club-forms/access";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { saveSubmissionSchema } from "@/modules/club-forms/schemas";
import { saveClubFormSubmission } from "@/modules/club-forms/submissions";

type RouteContext = { params: Promise<{ organizationId: string }> };

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * A director or deputy saves a draft or submits a club form for a member
 * (#610). The viewer is resolved server-side from the session and the club in
 * the URL; nothing in the body can name another club.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const viewer = await requireClubLeaderViewer(organizationId);
    const input = saveSubmissionSchema.parse(await readClubFormJson(request));
    const saved = await saveClubFormSubmission(viewer, { ...input, organizationId });
    return Response.json({ submission: saved }, { status: 201, headers: privateHeaders });
  } catch (error) {
    return clubFormApiError(error, "Saving a club form");
  }
}

export const POST = withRequestContext(postHandler);
