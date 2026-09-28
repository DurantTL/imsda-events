import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { approveRegistrationMove } from "@/modules/club-transfers/repository";
import { approveRegistrationMoveSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ moveId: string }> };

/** Conference staff approve one registration move (#489): the attendee and their dependent rows move; nothing is repriced. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { moveId } = await context.params;
    const actor = await requireStaffTransferAccess();
    const { note } = approveRegistrationMoveSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await approveRegistrationMove(moveId, note, actor));
  } catch (error) {
    return memberTransferApiError(error, "Approving a registration move");
  }
}

export const POST = withRequestContext(postHandler);
