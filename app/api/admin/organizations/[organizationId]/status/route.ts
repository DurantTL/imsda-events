import { z } from "zod";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { setDirectoryOrganizationActive } from "@/modules/organizations/eadventist-import-repository";

const bodySchema = z.object({ isActive: z.boolean() }).strict();

/** One-click active/inactive for a directory record (#649). Audited. */
async function patchHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const { isActive } = bodySchema.parse(await request.json());
    await setDirectoryOrganizationActive(organizationId, isActive, actor.id);
    return Response.json({ isActive }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return organizationApiError(error, "Changing an organization's status");
  }
}

export const PATCH = withRequestContext(patchHandler);
