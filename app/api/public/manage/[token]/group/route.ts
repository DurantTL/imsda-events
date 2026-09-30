import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { groupRegistrationApiError } from "@/modules/group-registrations/api-errors";
import { groupRegistrationEditInputSchema } from "@/modules/group-registrations/domain";
import { amendGroupRegistration, getGroupRegistrationWorkspace } from "@/modules/group-registrations/repository";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const maximumBodyBytes = 256 * 1024;
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

function withPrivateHeaders(response: Response, rateLimit?: RateLimitOutcome) {
  Object.entries(privateHeaders).forEach(([name, value]) => response.headers.set(name, value));
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

/** The group contact's registration: who is registered, classes, the estimate, and whether it can still change. */
async function getHandler(request: Request, context: Context) {
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "read");
    if (!rateLimit.allowed) {
      return json({ error: "RATE_LIMITED", message: "Too many requests for this private registration link. Try again later." }, { status: 429 }, rateLimit);
    }
    const workspace = await getGroupRegistrationWorkspace(token);
    if (!workspace) {
      return json({ error: "REGISTRATION_ACCESS_UNAVAILABLE", message: "This private registration link is invalid or no longer active." }, { status: 404 }, rateLimit);
    }
    return json({ workspace }, undefined, rateLimit);
  } catch (error) {
    return withPrivateHeaders(groupRegistrationApiError(error, "Loading the group registration"), rateLimit);
  }
}

/**
 * Reopens the group registration to add or remove people, or change their
 * details or the location, through the same amendment engine clubs use. The
 * private link is the authority: it reaches only its own group registration.
 */
async function patchHandler(request: Request, context: Context) {
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
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      return json({ error: "REQUEST_TOO_LARGE", message: "This registration is too large." }, { status: 413 }, rateLimit);
    }
    const input = groupRegistrationEditInputSchema.parse(JSON.parse(body));
    const { pendingMessageIds, result } = await amendGroupRegistration(token, input);
    try {
      await processQueuedMessageIdsAfterCommit(pendingMessageIds);
    } catch (error) {
      logError("Group registration edit notice processing failed after commit", error);
    }
    return json(result, undefined, rateLimit);
  } catch (error) {
    return withPrivateHeaders(groupRegistrationApiError(error, "Updating the group registration"), rateLimit);
  }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
