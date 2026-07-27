import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import {
  createOrganization,
  listOrganizations,
} from "@/modules/organizations/repository";
import { createOrganizationInputSchema } from "@/modules/organizations/schemas";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    await requireSystemAdministrator();
    return Response.json({ organizations: await listOrganizations() });
  } catch (error) {
    return organizationApiError(error, "Loading organizations");
  }
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = createOrganizationInputSchema.parse(await request.json());
    const organizations = await createOrganization(input, actor.id);
    return Response.json({ organizations }, { status: 201 });
  } catch (error) {
    return organizationApiError(error, "Creating an organization");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
