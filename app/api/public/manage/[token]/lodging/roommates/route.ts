import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { changeRegistrantRoommates, getRegistrantLodgingView } from "@/modules/lodging/preferences-service";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";
import { applyRateLimitHeaders, mergeRateLimitOutcomes, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit, checkPublicRoommateLookupRateLimit } from "@/modules/rate-limit/service";

/**
 * The registrant asks to room with someone, or takes the request back (#199). Someone on another registration is
 * found by name and confirmation code together; every miss gets the same answer, and the response never says who
 * has asked for this registration or shows a contact detail. Same-origin only; rate limited per link.
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

async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "update");
    if (!rateLimit.allowed) {
      return json({ error: "RATE_LIMITED", message: "Too many updates for this private registration link. Try again later." }, { status: 429 }, rateLimit);
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
      return json({ error: "REQUEST_TOO_LARGE", message: "The roommate request is too large." }, { status: 413 }, rateLimit);
    }
    // A lookup by name and confirmation code is the one thing here that could be used to guess codes: it has its own,
    // tighter budget on top of the update budget.
    let isLookup = false;
    try { isLookup = (JSON.parse(body) as { action?: unknown } | null)?.action === "add_by_code"; } catch { /* the service reports bad JSON */ }
    if (isLookup) {
      rateLimit = mergeRateLimitOutcomes(rateLimit, await checkPublicRoommateLookupRateLimit(request, token));
      if (!rateLimit.allowed) {
        return json({ error: "RATE_LIMITED", message: "Too many roommate lookups for this private registration link. Try again later." }, { status: 429 }, rateLimit);
      }
    }
    const access = await authorizeRegistrationAccessToken(token);
    if (!access) {
      return json({ error: "REGISTRATION_ACCESS_UNAVAILABLE", message: "This private registration link is invalid or no longer active." }, { status: 404 }, rateLimit);
    }
    const result = await changeRegistrantRoommates({ eventId: access.eventId, registrationId: access.registrationId, accessTokenId: access.accessTokenId, raw: JSON.parse(body) });
    return json({ result, lodging: await getRegistrantLodgingView({ eventId: access.eventId, registrationId: access.registrationId }) }, undefined, rateLimit);
  } catch (error) {
    const failure = lodgingApiError(error, "Saving the roommate request");
    return rateLimit ? applyRateLimitHeaders(failure, rateLimit) : failure;
  }
}

export const POST = withRequestContext(postHandler);
