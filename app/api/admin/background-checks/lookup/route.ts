import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { lookupBackgroundCheckName } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * "Why isn't this person matched?" (#598): list rows and roster or
 * registration people with the same or a similar name, and the reason each
 * pair did or didn't match. Read-only and staff-only; never returns a birth
 * date.
 */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    const name = new URL(request.url).searchParams.get("name") ?? "";
    return Response.json({ lookup: await lookupBackgroundCheckName(name) });
  } catch (error) {
    return backgroundCheckApiError(error, "Looking up a Sterling Volunteers name");
  }
}

export const GET = withRequestContext(getHandler);
