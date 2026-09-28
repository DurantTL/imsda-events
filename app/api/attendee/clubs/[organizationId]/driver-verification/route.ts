import { requireClubDriverReviewAccess } from "@/modules/driver-verification/access";
import { driverVerificationApiError } from "@/modules/driver-verification/api-errors";
import { listWillingDrivers } from "@/modules/driver-verification/repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's own driver verification queue (#491): its director or deputy —
 * the same leader-only capability that already gates managing the club's
 * team — see only their own club's willing drivers, never another club's.
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireClubDriverReviewAccess(organizationId);
    const entries = await listWillingDrivers({ kind: "CLUB", organizationId });
    return Response.json({ entries });
  } catch (error) {
    return driverVerificationApiError(error, "Loading the driver verification queue");
  }
}

export const GET = withRequestContext(getHandler);
