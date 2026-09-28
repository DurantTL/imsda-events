import { requireGlobalDriverReviewAccess } from "@/modules/driver-verification/access";
import { driverVerificationApiError } from "@/modules/driver-verification/api-errors";
import { listWillingDrivers } from "@/modules/driver-verification/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * The conference-wide driver verification queue (#491): every willing
 * driver on a current, active staff or adult roster row, across every club,
 * for a system administrator to review.
 */
async function getHandler() {
  try {
    await requireGlobalDriverReviewAccess();
    const entries = await listWillingDrivers({ kind: "GLOBAL" });
    return Response.json({ entries });
  } catch (error) {
    return driverVerificationApiError(error, "Loading the driver verification queue");
  }
}

export const GET = withRequestContext(getHandler);
