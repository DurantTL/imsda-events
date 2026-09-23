import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { honorApiError } from "@/modules/honors/api-errors";
import { updateHonor } from "@/modules/honors/repository";
import { honorUpdateSchema } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(request: Request, context: { params: Promise<{ honorId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { honorId } = await context.params;
    const input = honorUpdateSchema.parse(await request.json());
    return Response.json({ honors: await updateHonor(honorId, input, actor.id) });
  } catch (error) {
    return honorApiError(error, "Updating an honor");
  }
}

export const PATCH = withRequestContext(patchHandler);
