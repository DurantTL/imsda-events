import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import {
  createDirectorGrant,
  listDirectorGrants,
} from "@/modules/organizations/director-grants-repository";
import { createDirectorGrantInputSchema } from "@/modules/organizations/director-grants-schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

async function getHandler(_request: Request, context: RouteContext) {
  try {
    await requireSystemAdministrator();
    const { organizationId } = await context.params;
    return Response.json(await listDirectorGrants(organizationId));
  } catch (error) {
    return organizationApiError(error, "Loading club directors");
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const input = createDirectorGrantInputSchema.parse(await request.json());
    return Response.json(
      await createDirectorGrant(organizationId, input, actor.id),
      { status: 201 },
    );
  } catch (error) {
    return organizationApiError(error, "Assigning a club director");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
