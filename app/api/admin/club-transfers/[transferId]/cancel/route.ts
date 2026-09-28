import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { staffCancelTransfer } from "@/modules/club-transfers/repository";
import { staffCancelTransferSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ transferId: string }> };

/** Conference staff close an open transfer without moving anyone (#489), with a required note. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { transferId } = await context.params;
    const actor = await requireStaffTransferAccess();
    const { note } = staffCancelTransferSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await staffCancelTransfer(transferId, note, actor));
  } catch (error) {
    return memberTransferApiError(error, "Closing a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
