import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { discardClubFormDraft, saveClubFormDraft } from "@/modules/club-forms/builder";
import { saveDraftSchema } from "@/modules/club-forms/builder-domain";
import { requireSystemAdministrator } from "@/modules/organizations/access";

type RouteContext = { params: Promise<{ templateKey: string }> };

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** A system administrator saves the draft of the next version of a club form (#712). Invalid drafts come back with field-level issues. */
async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const admin = await requireSystemAdministrator();
    const { templateKey } = await context.params;
    const input = saveDraftSchema.parse(await readClubFormJson(request));
    return Response.json(await saveClubFormDraft(templateKey, input, admin.id), { headers: noStore });
  } catch (error) {
    return clubFormApiError(error, "Saving a club form draft");
  }
}

/** A system administrator throws a draft away (#712). */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const admin = await requireSystemAdministrator();
    const { templateKey } = await context.params;
    return Response.json(await discardClubFormDraft(templateKey, admin.id), { headers: noStore });
  } catch (error) {
    return clubFormApiError(error, "Discarding a club form draft");
  }
}

export const PUT = withRequestContext(putHandler);
export const DELETE = withRequestContext(deleteHandler);
