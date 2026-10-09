import { getHostedReturnStatus } from "@/modules/payments/square-hosted-return";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkPublicPaymentRateLimit } from "@/modules/rate-limit/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type RouteContext = { params: Promise<{ returnId: string }> };

/**
 * The status poll behind Square's return page (#327), keyed by the opaque return id. It answers a
 * state and a masked confirmation code; an unknown or expired id is a plain 404.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { returnId } = await context.params;
    const rateLimit = await checkPublicPaymentRateLimit(request, `square-return:${returnId}`);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: privateHeaders }),
        rateLimit,
      );
    }
    const status = await getHostedReturnStatus(returnId);
    const response = status
      ? Response.json(status, { headers: privateHeaders })
      : Response.json({ error: "NOT_FOUND" }, { status: 404, headers: privateHeaders });
    return applyRateLimitHeaders(response, rateLimit);
  } catch (error) {
    logError("Square return status failed.", error);
    return Response.json({ error: "STATUS_UNAVAILABLE" }, { status: 500, headers: privateHeaders });
  }
}

export const GET = withRequestContext(getHandler);
