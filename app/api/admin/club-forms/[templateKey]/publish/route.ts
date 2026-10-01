import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { publishClubFormDraft } from "@/modules/club-forms/builder";
import { publishSchema } from "@/modules/club-forms/builder-domain";
import { requireSystemAdministrator } from "@/modules/organizations/access";

type RouteContext = { params: Promise<{ templateKey: string }> };

/** A system administrator publishes the saved draft as the next version of a club form (#712). */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const admin = await requireSystemAdministrator();
    const { templateKey } = await context.params;
    const input = publishSchema.parse(await readClubFormJson(request));
    return Response.json(await publishClubFormDraft(templateKey, input, admin.id), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return clubFormApiError(error, "Publishing a club form");
  }
}

export const POST = withRequestContext(postHandler);
