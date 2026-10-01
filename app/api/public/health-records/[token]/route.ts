import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { healthApiError, healthDisabledResponse, healthJson, readHealthJson } from "@/modules/health-records/api";
import { resolveHealthLinkForFill, submitHealthRecordViaLink } from "@/modules/health-records/repository";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkClubFormLinkRateLimit } from "@/modules/rate-limit/service";

/**
 * The Health Record private link's own API (#611): no account, only the
 * token. Every unusable link gets the same 404. It shares the club form
 * link's rate limit budgets (per client, per token and per pair).
 */

type RouteContext = { params: Promise<{ token: string }> };

function limited(rateLimit: RateLimitOutcome) {
  return applyRateLimitHeaders(
    healthJson({ error: "RATE_LIMITED", message: "Too many requests for this private link. Try again later." }, { status: 429 }),
    rateLimit,
  );
}

async function getHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  try {
    const { token } = await context.params;
    const rateLimit = await checkClubFormLinkRateLimit(request, token, "read");
    if (!rateLimit.allowed) return limited(rateLimit);
    return applyRateLimitHeaders(healthJson({ form: await resolveHealthLinkForFill(token) }), rateLimit);
  } catch (error) {
    return healthApiError(error, "Opening a health record link");
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { token } = await context.params;
    const rateLimit = await checkClubFormLinkRateLimit(request, token, "submit");
    if (!rateLimit.allowed) return limited(rateLimit);
    await submitHealthRecordViaLink(token, await readHealthJson(request));
    // The record id stays inside; the parent only needs to know it worked.
    return applyRateLimitHeaders(healthJson({ ok: true }, { status: 201 }), rateLimit);
  } catch (error) {
    return healthApiError(error, "Submitting a health record");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
