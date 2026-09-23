import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { revealRosterBirthDates } from "@/modules/club-rosters/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * Full birth dates for the staff "Open club" view (#386). System administrators
 * may see them (ADR 0005); POST so every reveal is an audited action.
 */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const birthDates = await revealRosterBirthDates(organizationId, clubYearFor(new Date()), { userId: actor.id });
    return Response.json({ birthDates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return organizationApiError(error, "Showing roster birth dates");
  }
}

export const POST = withRequestContext(postHandler);
