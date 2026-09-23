import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { getEventHonorSetup, listHonors } from "@/modules/honors/repository";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requireHonorPermission(eventId);
    const [setup, honors] = await Promise.all([getEventHonorSetup(eventId), listHonors()]);
    return Response.json({ ...setup, catalog: honors.filter((honor) => honor.isActive) });
  } catch (error) {
    return honorApiError(error, "Loading honors setup");
  }
}

export const GET = withRequestContext(getHandler);
