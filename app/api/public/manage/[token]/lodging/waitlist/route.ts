import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getRegistrantAssignmentView } from "@/modules/lodging/assignment-view";
import { applyRegistrantWaitlistAction, getRegistrantWaitlistView } from "@/modules/lodging/waitlist-service";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

/**
 * The guest joins the lodging waitlist when a type is full (events set to waitlist), or accepts or declines a live
 * offer (#200), from the private registration page. The link names the registration; only its own entry can be
 * touched. Same-origin only; rate limited per link. An answer after the offer expired records the expiry and says so.
 */

const maximumBodyBytes = 2 * 1_024;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type Context = { params: Promise<{ token: string }> };

function json(body: unknown, init?: ResponseInit, rateLimit?: RateLimitOutcome) {
  const response = Response.json(body, { ...init, headers: { ...privateHeaders, ...init?.headers } });
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

const unavailable = { error: "REGISTRATION_ACCESS_UNAVAILABLE", message: "This private registration link is invalid or no longer active." };

async function getHandler(request: Request, context: Context) {
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "read");
    if (!rateLimit.allowed) return json({ error: "RATE_LIMITED", message: "Too many requests for this private registration link. Try again later." }, { status: 429 }, rateLimit);
    const access = await authorizeRegistrationAccessToken(token);
    if (!access) return json(unavailable, { status: 404 }, rateLimit);
    return json({ waitlist: await getRegistrantWaitlistView({ eventId: access.eventId, registrationId: access.registrationId }) }, undefined, rateLimit);
  } catch (error) {
    logError("Private lodging waitlist view failed.", error);
    return json({ error: "LODGING_REQUEST_FAILED", message: "The waitlist could not be loaded. Try again in a moment." }, { status: 500 });
  }
}

async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "update");
    if (!rateLimit.allowed) return json({ error: "RATE_LIMITED", message: "Too many updates for this private registration link. Try again later." }, { status: 429 }, rateLimit);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) return json({ error: "REQUEST_TOO_LARGE", message: "The waitlist request is too large." }, { status: 413 }, rateLimit);
    const access = await authorizeRegistrationAccessToken(token);
    if (!access) return json(unavailable, { status: 404 }, rateLimit);
    const result = await applyRegistrantWaitlistAction({ eventId: access.eventId, registrationId: access.registrationId, accessTokenId: access.accessTokenId, raw: JSON.parse(body) });
    if (result.status === "EXPIRED") {
      return json({ error: "WAITLIST_OFFER_EXPIRED", message: "That offer has expired, so it can no longer be answered. Contact the event team if you still need a place." }, { status: 409 }, rateLimit);
    }
    return json({
      result,
      waitlist: await getRegistrantWaitlistView({ eventId: access.eventId, registrationId: access.registrationId }),
      assignments: await getRegistrantAssignmentView({ eventId: access.eventId, registrationId: access.registrationId }),
    }, undefined, rateLimit);
  } catch (error) {
    const failure = lodgingApiError(error, "Updating the lodging waitlist");
    return rateLimit ? applyRateLimitHeaders(failure, rateLimit) : failure;
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
