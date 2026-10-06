import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listBackgroundCheckReviews } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * The Sterling Volunteers staff review list (#527): entries, or people, an
 * upload couldn't match with confidence. Staff-only, like the rest of
 * Sterling Volunteers data.
 */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    const reviews = await listBackgroundCheckReviews();
    return Response.json({ reviews });
  } catch (error) {
    return backgroundCheckApiError(error, "Loading the Sterling Volunteers review list");
  }
}

export const GET = withRequestContext(getHandler);
