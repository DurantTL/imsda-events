import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getRegistrantLodgingView, saveLodgingRequest } from "@/modules/lodging/preferences-service";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

/**
 * The registrant sets or changes the lodging they would like (#199) from the private registration page. The token
 * names the registration; only that registration's own request can be read or written, and only until the event's
 * lodging deadline. Same-origin only. This is a preference, not an assignment: it holds no unit.
 *
 * Unlike changes to identity answers, a lodging preference is open to the link even when the event verifies every
 * edit: it is a yes/no and category choice, the same class as a seminar preference, and the deadline bounds it.
 */

const maximumBodyBytes = 4 * 1_024;
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
    if (!rateLimit.allowed) {
      return json({ error: "RATE_LIMITED", message: "Too many requests for this private registration link. Try again later." }, { status: 429 }, rateLimit);
    }
    const access = await authorizeRegistrationAccessToken(token);
    if (!access) return json(unavailable, { status: 404 }, rateLimit);
    return json({ lodging: await getRegistrantLodgingView({ eventId: access.eventId, registrationId: access.registrationId }) }, undefined, rateLimit);
  } catch (error) {
    logError("Private lodging view failed.", error);
    return json({ error: "LODGING_REQUEST_FAILED", message: "Lodging could not be loaded. Try again in a moment." }, { status: 500 });
  }
}

async function putHandler(request: Request, context: Context) {
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
      return json({ error: "REQUEST_TOO_LARGE", message: "The lodging update is too large." }, { status: 413 }, rateLimit);
    }
    const access = await authorizeRegistrationAccessToken(token);
    if (!access) return json(unavailable, { status: 404 }, rateLimit);
    const result = await saveLodgingRequest({
      eventId: access.eventId,
      registrationId: access.registrationId,
      actor: { kind: "REGISTRANT", accessTokenId: access.accessTokenId },
      raw: JSON.parse(body),
    });
    return json({ result, lodging: await getRegistrantLodgingView({ eventId: access.eventId, registrationId: access.registrationId }) }, undefined, rateLimit);
  } catch (error) {
    const failure = lodgingApiError(error, "Saving the lodging preference");
    return rateLimit ? applyRateLimitHeaders(failure, rateLimit) : failure;
  }
}

export const GET = withRequestContext(getHandler);
export const PUT = withRequestContext(putHandler);
