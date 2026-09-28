import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { staffFinishTransfer } from "@/modules/club-transfers/repository";
import { staffResolveTransferSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ transferId: string }> };

/** Conference staff finish a transfer the sending club hasn't acknowledged in time (#489). */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { transferId } = await context.params;
    const actor = await requireStaffTransferAccess();
    const { note } = staffResolveTransferSchema.parse(await request.json().catch(() => ({})));
    const result = await staffFinishTransfer(transferId, note, actor);
    return Response.json(result);
  } catch (error) {
    return memberTransferApiError(error, "Finishing a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
