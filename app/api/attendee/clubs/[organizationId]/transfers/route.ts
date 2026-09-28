import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { initiateTransfer, listClubTransfers } from "@/modules/club-transfers/repository";
import { initiateTransferSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** A club's own transfer history (#489), both directions, shown on its roster. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireClubTransferAccess(organizationId);
    const transfers = await listClubTransfers(organizationId);
    return Response.json({ transfers });
  } catch (error) {
    return memberTransferApiError(error, "Loading club transfers");
  }
}

/**
 * The receiving club's director or deputy starts a transfer while enrolling
 * the member (#489): `fromOrganizationId` and `fromRosterMemberId` name the
 * existing active roster row at another club (found through the search
 * endpoint), and `organizationId` on the route is the receiving club.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    const input = initiateTransferSchema.parse(await request.json());
    const result = await initiateTransfer(organizationId, input, access.actor);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return memberTransferApiError(error, "Starting a member transfer");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
