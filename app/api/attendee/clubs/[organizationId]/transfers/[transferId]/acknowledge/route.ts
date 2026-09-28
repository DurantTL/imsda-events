import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { acknowledgeTransfer } from "@/modules/club-transfers/repository";
import { acknowledgeTransferSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; transferId: string }> };

/**
 * The sending club's director or deputy acknowledges a pending transfer
 * (#489): its roster row is removed, honor history stays with the person,
 * and open event registrations re-point to the receiving club.
 * `organizationId` on the route must be the sending club — never the
 * receiving one, and never another club's transfer.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, transferId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    acknowledgeTransferSchema.parse(await request.json().catch(() => ({})));
    const result = await acknowledgeTransfer(organizationId, transferId, access.actor);
    return Response.json(result);
  } catch (error) {
    return memberTransferApiError(error, "Acknowledging a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
