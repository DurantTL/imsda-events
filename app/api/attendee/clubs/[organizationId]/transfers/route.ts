import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubTransferAccess, transferRateLimitKey } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { listClubTransfers, requestTransfer } from "@/modules/club-transfers/repository";
import { requestTransferSchema } from "@/modules/club-transfers/schemas";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkClubTransferRequestRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** A club's own transfers (#489): requests it made, requests made of it, and their history. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    const transfers = await listClubTransfers(organizationId, access.actor);
    return Response.json(transfers);
  } catch (error) {
    return memberTransferApiError(error, "Loading club transfers");
  }
}

/**
 * The receiving club's director or deputy requests a transfer (#489):
 * the member's exact name, their current club, and a reason. The answer is
 * always "request sent", whether or not the name matched anyone, so this
 * can't be used to find out who is on another club's roster. Rate-limited
 * per director, per club, and per client.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    const rateLimit = await checkClubTransferRequestRateLimit(request, transferRateLimitKey(access.actor), organizationId);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many transfer requests. Try again later.",
      }, { status: 429 }), rateLimit);
    }
    const input = requestTransferSchema.parse(await request.json().catch(() => ({})));
    await requestTransfer(organizationId, input, access.actor);
    return applyRateLimitHeaders(Response.json({
      ok: true,
      message: "Request sent. You'll see it here as pending until it's answered.",
    }, { status: 202 }), rateLimit);
  } catch (error) {
    return memberTransferApiError(error, "Requesting a member transfer");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
