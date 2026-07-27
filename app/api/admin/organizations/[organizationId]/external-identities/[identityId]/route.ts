import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { updateOrganizationExternalIdentity } from "@/modules/organizations/repository";
import { updateExternalIdentityInputSchema } from "@/modules/organizations/schemas";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(
  request: Request,
  context: {
    params: Promise<{ organizationId: string; identityId: string }>;
  },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId, identityId } = await context.params;
    const input = updateExternalIdentityInputSchema.parse(await request.json());
    return Response.json({
      organizations: await updateOrganizationExternalIdentity(
        organizationId,
        identityId,
        input,
        actor.id,
      ),
    });
  } catch (error) {
    return organizationApiError(error, "Updating an external identity");
  }
}

export const PATCH = withRequestContext(patchHandler);
