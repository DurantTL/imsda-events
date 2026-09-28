import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { writeBackHonorsWeekendCompletions } from "@/modules/honors/weekend-completion-repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * Writes back checked-in Honors Weekend class enrollments (#357–#360) into
 * each member's year-round honor record (#487, #486). Idempotent: an
 * enrollment already written back is skipped, so running this again after
 * more people check in only writes the new ones.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireHonorPermission(eventId);
    return Response.json(await writeBackHonorsWeekendCompletions(eventId, access.user.id));
  } catch (error) {
    return honorApiError(error, "Writing back Honors Weekend completions");
  }
}

export const POST = withRequestContext(postHandler);
