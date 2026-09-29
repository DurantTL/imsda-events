import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { approveRegistrationMove } from "@/modules/club-transfers/repository";
import { approveRegistrationMoveSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";
import { logError } from "@/lib/logger";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";

type RouteContext = { params: Promise<{ moveId: string }> };

/** Conference staff approve one registration move (#489): the attendee and their dependent rows move; nothing is repriced. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { moveId } = await context.params;
    const actor = await requireStaffTransferAccess();
    const { note } = approveRegistrationMoveSchema.parse(await request.json().catch(() => ({})));
    const { pendingMessageIds = [], ...result } = await approveRegistrationMove(moveId, note, actor);
    // A seat this move opened at a location may have been offered to its waitlist (#599):
    // sent after commit, and a delivery problem never undoes the move.
    if (pendingMessageIds.length > 0) {
      await processQueuedMessageIdsAfterCommit(pendingMessageIds).catch((error) => {
        logError("Waitlist promotion email delivery failed after a registration move", error);
      });
    }
    return Response.json(result);
  } catch (error) {
    return memberTransferApiError(error, "Approving a registration move");
  }
}

export const POST = withRequestContext(postHandler);
