import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { revealRosterBirthDates } from "@/modules/club-rosters/repository";
import { withRequestContext } from "@/lib/request-context";

/** POST, not GET: showing full birth dates is an audited action, never a cacheable read. */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const birthDates = await revealRosterBirthDates(organizationId, clubYearFor(new Date()), { accountId: access.accountId });
    return Response.json({ birthDates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return rosterApiError(error, "Showing birth dates");
  }
}

export const POST = withRequestContext(postHandler);
