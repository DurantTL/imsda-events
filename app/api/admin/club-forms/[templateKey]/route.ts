import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { templateEnabledSchema } from "@/modules/club-forms/schemas";
import { setClubFormTemplateEnabled } from "@/modules/club-forms/templates";
import { requireSystemAdministrator } from "@/modules/organizations/access";

type RouteContext = { params: Promise<{ templateKey: string }> };

/** A system administrator turns one club form on or off (#610). Nobody else can. */
async function patchHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const admin = await requireSystemAdministrator();
    const { templateKey } = await context.params;
    const { enabled } = templateEnabledSchema.parse(await readClubFormJson(request));
    return Response.json(await setClubFormTemplateEnabled(templateKey, enabled, admin.id), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return clubFormApiError(error, "Changing a club form");
  }
}

export const PATCH = withRequestContext(patchHandler);
