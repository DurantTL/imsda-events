import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { updateOrganization } from "@/modules/organizations/repository";
import { updateOrganizationInputSchema } from "@/modules/organizations/schemas";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const input = updateOrganizationInputSchema.parse(await request.json());
    return Response.json({
      organizations: await updateOrganization(
        organizationId,
        input,
        actor.id,
      ),
    });
  } catch (error) {
    return organizationApiError(error, "Updating an organization");
  }
}

export const PATCH = withRequestContext(patchHandler);
