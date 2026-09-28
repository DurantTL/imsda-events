import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { acceptTransfer } from "@/modules/club-transfers/repository";
import { acceptTransferSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; transferId: string }> };

/**
 * The sending club's director or deputy accepts a transfer request (#489).
 * `organizationId` on the route must be the sending club; any other
 * transfer reads as not found. The member's roster row moves, and their
 * open club registrations are queued for conference staff to approve.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, transferId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    acceptTransferSchema.parse(await request.json().catch(() => ({})));
    const result = await acceptTransfer(organizationId, transferId, access.actor);
    return Response.json({ transferId: result.transferId, registrationMovesQueued: result.registrationMovesQueued });
  } catch (error) {
    return memberTransferApiError(error, "Accepting a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
