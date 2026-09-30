import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { groupRegistrationApiError } from "@/modules/group-registrations/api-errors";
import { setGroupClassesByToken } from "@/modules/group-registrations/repository";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

const selectionsSchema = z.object({
  selections: z.record(z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(6)),
}).strict().refine((input) => Object.keys(input.selections).length <= 50, "Too many people in one save.");

type Context = { params: Promise<{ token: string }> };

/** Saves class choices for the group's people. Seats, ages and the group's own per-club limit are the server's. */
async function putHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "update");
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        Response.json({ error: "RATE_LIMITED", message: "Too many updates for this private registration link. Try again later." }, { status: 429, headers: privateHeaders }),
        rateLimit,
      );
    }
    const { selections } = selectionsSchema.parse(await request.json());
    const classes = await setGroupClassesByToken(token, selections);
    // Same shape as a club's class save, so the one class picker reads both.
    return applyRateLimitHeaders(Response.json({ workspace: classes }, { headers: privateHeaders }), rateLimit);
  } catch (error) {
    const response = groupRegistrationApiError(error, "Saving class choices");
    Object.entries(privateHeaders).forEach(([name, value]) => response.headers.set(name, value));
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const PUT = withRequestContext(putHandler);
