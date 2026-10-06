import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listBackgroundCheckReviews, resolveBackgroundCheckReview, restoreDismissedBackgroundCheckReview } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ reviewId: string }> };

const resolveSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("match"), personId: z.string().min(1) }),
  z.object({ type: z.literal("dismiss") }),
]);

/**
 * Resolving one Sterling Volunteers review by hand (#527): match it to one of
 * the listed candidates (a staff match, held across refreshes and uploads
 * until staff undo it), or dismiss it. A dismissal holds until the next
 * upload replaces the list: that entry is matched to no one meanwhile, and
 * anyone it named isn't auto-matched to a sibling row whose review is still
 * open. 409 while an upload is in progress or when the list changed
 * mid-save; 404 for a review that's gone; 400 for a non-candidate. Staff-only;
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
    return backgroundCheckApiError(error, "Resolving a Sterling Volunteers review");
  }
}

/**
 * Undo a dismissal (#702): the review is open again. Same system-administrator
 * gate as dismissing. 404 when the review is gone or was never dismissed.
 */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { reviewId } = await context.params;
    await restoreDismissedBackgroundCheckReview(reviewId, actor.id);
    return Response.json({ reviews: await listBackgroundCheckReviews() });
  } catch (error) {
    return backgroundCheckApiError(error, "Undoing a Sterling Volunteers dismissal");
  }
}

export const POST = withRequestContext(postHandler);
export const DELETE = withRequestContext(deleteHandler);
