import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { staffOverrideTransfer } from "@/modules/club-transfers/repository";
import { staffOverrideTransferSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ transferId: string }> };

/** Conference staff override any open transfer (#489), any time, with a required note. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { transferId } = await context.params;
    const actor = await requireStaffTransferAccess();
    const input = staffOverrideTransferSchema.parse(await request.json().catch(() => ({})));
    const result = await staffOverrideTransfer(transferId, input, actor);
    return Response.json({ transferId: result.transferId, registrationMovesQueued: result.registrationMovesQueued });
  } catch (error) {
    return memberTransferApiError(error, "Overriding a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
