import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubLeaderViewer } from "@/modules/club-forms/access";
import { clubFormApiError } from "@/modules/club-forms/api-errors";
import { revokeClubFormLink } from "@/modules/club-forms/links";

type RouteContext = { params: Promise<{ organizationId: string; linkId: string }> };

/** A director or deputy withdraws an open private link of their own club (#610). */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, linkId } = await context.params;
    const viewer = await requireClubLeaderViewer(organizationId);
    await revokeClubFormLink(viewer, organizationId, linkId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return clubFormApiError(error, "Withdrawing a club form link");
  }
}

export const DELETE = withRequestContext(deleteHandler);
