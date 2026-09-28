import { requireClubDriverReviewAccess } from "@/modules/driver-verification/access";
import { driverVerificationApiError } from "@/modules/driver-verification/api-errors";
import { clubDriverEntries } from "@/modules/driver-verification/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's own driver list (#544): its director or deputy see each willing
 * driver's clearance label ("Cleared to drive", "Expiring (date)", "Not
 * cleared" or "Pending") for their own club only. Never the background-check
 * issues text (#427), a reason, or an override note; a club can't override
 * clearance, only staff can.
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireClubDriverReviewAccess(organizationId);
    const entries = await clubDriverEntries(organizationId, clubYearFor(new Date()));
    return Response.json({ entries });
  } catch (error) {
    return driverVerificationApiError(error, "Loading the club driver list");
  }
}

export const GET = withRequestContext(getHandler);
