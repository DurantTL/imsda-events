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
    const headers = { "Cache-Control": "private, no-store, max-age=0" };
    const result = await runClubFormTemplateSync(admin.id);
    // Another sync holds the lock: say so, and change nothing.
    if ("running" in result) {
      return Response.json(
        { code: "SYNC_RUNNING", error: "SYNC_RUNNING", message: "A sync is already running. Reload in a minute to see each form's status." },
        { status: 409, headers },
      );
    }
    return Response.json(result, { headers });
  } catch (error) {
    return clubFormApiError(error, "Syncing club form templates");
  }
}

export const POST = withRequestContext(postHandler);
