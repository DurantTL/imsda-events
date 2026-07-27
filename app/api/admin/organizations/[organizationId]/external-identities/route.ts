import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { addOrganizationExternalIdentity } from "@/modules/organizations/repository";
import { externalIdentityInputSchema } from "@/modules/organizations/schemas";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const input = externalIdentityInputSchema.parse(await request.json());
    return Response.json({
      organizations: await addOrganizationExternalIdentity(
        organizationId,
        input,
        actor.id,
      ),
    }, { status: 201 });
  } catch (error) {
    return organizationApiError(error, "Linking an external identity");
  }
}

export const POST = withRequestContext(postHandler);
