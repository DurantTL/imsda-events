import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { listStaffTransferCandidates } from "@/modules/club-transfers/repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ transferId: string }> };

/** For overriding an unmatched request (#489): the sending club's active members this club year, names only. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { transferId } = await context.params;
    await requireStaffTransferAccess();
    return Response.json({ candidates: await listStaffTransferCandidates(transferId) });
  } catch (error) {
    return memberTransferApiError(error, "Loading transfer candidates");
  }
}

export const GET = withRequestContext(getHandler);
