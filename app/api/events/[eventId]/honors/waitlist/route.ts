import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { ClassSelectionError, setHonorWaitlistOfferHours } from "@/modules/honors/waitlist-repository";
import { waitlistOfferHoursMax, waitlistOfferHoursMin } from "@/modules/honors/waitlist-domain";
import { withRequestContext } from "@/lib/request-context";

const settingsSchema = z.object({
  offerHours: z.number().int().min(waitlistOfferHoursMin).max(waitlistOfferHoursMax),
}).strict();

/** How long a club director has to accept a seat offered from a class waitlist (#831), for this event. */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = settingsSchema.parse(await request.json());
    return Response.json(await setHonorWaitlistOfferHours(eventId, input.offerHours, access.user.id));
  } catch (error) {
    if (error instanceof ClassSelectionError) {
      return Response.json({ error: error.code, message: error.message }, { status: 422 });
    }
    return honorApiError(error, "Saving the class waitlist window");
  }
}

export const PUT = withRequestContext(putHandler);
