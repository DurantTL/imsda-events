import { requireGlobalDriverReviewAccess } from "@/modules/driver-verification/access";
import { driverVerificationApiError } from "@/modules/driver-verification/api-errors";
import { listDriverExceptions } from "@/modules/driver-verification/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * The conference-wide driver exceptions (#544): willing drivers on a current
 * roster, across every club, whom the background-check list marks as needing
 * review, not cleared, or expiring soon. Cleared drivers are not listed.
 */
async function getHandler() {
  try {
    await requireGlobalDriverReviewAccess();
    const entries = await listDriverExceptions();
    return Response.json({ entries });
  } catch (error) {
    return driverVerificationApiError(error, "Loading the driver exceptions");
  }
}

export const GET = withRequestContext(getHandler);
