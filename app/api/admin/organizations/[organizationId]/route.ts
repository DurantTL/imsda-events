import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { deleteOrganization, updateOrganization } from "@/modules/organizations/repository";
import { updateOrganizationInputSchema } from "@/modules/organizations/schemas";
import { withRequestContext } from "@/lib/request-context";

const deleteInputSchema = z.object({ confirmName: z.string().trim().min(1, "Type the name to confirm.").max(200) });

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

/** Deletes a church or club for good (#386). The typed name is the confirmation. */
async function deleteHandler(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const { confirmName } = deleteInputSchema.parse(await request.json());
    return Response.json({
      organizations: await deleteOrganization(organizationId, confirmName, actor.id),
    });
  } catch (error) {
    return organizationApiError(error, "Deleting an organization");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
