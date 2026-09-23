import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { getOrganizationDeletionCheck } from "@/modules/organizations/repository";
import { withRequestContext } from "@/lib/request-context";

/** What deleting this church or club would remove, and anything that stops it (#386). */
async function getHandler(
  _request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    await requireSystemAdministrator();
    const { organizationId } = await context.params;
    return Response.json(
      { check: await getOrganizationDeletionCheck(organizationId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return organizationApiError(error, "Checking an organization deletion");
  }
}

export const GET = withRequestContext(getHandler);
