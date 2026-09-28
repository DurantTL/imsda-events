import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listBackgroundCheckReviews, resolveBackgroundCheckReview } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ reviewId: string }> };

const resolveSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("match"), personId: z.string().min(1) }),
  z.object({ type: z.literal("dismiss") }),
]);

/**
 * Resolving one background-check review by hand (#527): match it to one of
 * the listed candidates, remembered for the next upload, or dismiss it
 * (never remembered — the same ambiguity may resurface later). Staff-only;
 * nothing here is guessed.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { reviewId } = await context.params;
    const decision = resolveSchema.parse(await request.json());
    await resolveBackgroundCheckReview(reviewId, decision, actor.id);
    return Response.json({ reviews: await listBackgroundCheckReviews() });
  } catch (error) {
    return backgroundCheckApiError(error, "Resolving a background check review");
  }
}

export const POST = withRequestContext(postHandler);
