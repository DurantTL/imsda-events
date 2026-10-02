import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubFormApiError } from "@/modules/club-forms/api-errors";
import { runClubFormTemplateSync } from "@/modules/club-forms/templates";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * A system administrator brings the club form templates up to the code's
 * version (#742). Same sync as `npm run club-forms:sync`; the audit entry
 * holds counts only.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const admin = await requireSystemAdministrator();
    return Response.json(await runClubFormTemplateSync(admin.id), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return clubFormApiError(error, "Syncing club form templates");
  }
}

export const POST = withRequestContext(postHandler);
