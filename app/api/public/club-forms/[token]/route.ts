import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubFormApiError } from "@/modules/club-forms/api-errors";
import { resolveClubFormLinkForFill, submitClubFormViaLink } from "@/modules/club-forms/links";
import { publicSubmitSchema } from "@/modules/club-forms/schemas";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkClubFormLinkRateLimit } from "@/modules/rate-limit/service";

/**
 * The private link's own API (#610): no account, only the token. Every
 * unusable link (unknown, expired, used, withdrawn, or its form switched off)
 * gets the same 404, so nothing says which it was. Rate limited per client,
 * per token and per pair.
 */

const maximumBodyBytes = 300_000;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type RouteContext = { params: Promise<{ token: string }> };

function json(body: unknown, init: ResponseInit = {}, rateLimit?: RateLimitOutcome) {
  const response = Response.json(body, { ...init, headers: { ...privateHeaders, ...init.headers } });
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

function limited(rateLimit: RateLimitOutcome) {
  return json({ error: "RATE_LIMITED", message: "Too many requests for this private link. Try again later." }, { status: 429 }, rateLimit);
}

function failure(error: unknown, action: string, rateLimit?: RateLimitOutcome) {
  const response = clubFormApiError(error, action);
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

async function getHandler(request: Request, context: RouteContext) {
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkClubFormLinkRateLimit(request, token, "read");
    if (!rateLimit.allowed) return limited(rateLimit);
    return json({ form: await resolveClubFormLinkForFill(token) }, undefined, rateLimit);
  } catch (error) {
    return failure(error, "Opening a club form link", rateLimit);
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkClubFormLinkRateLimit(request, token, "submit");
    if (!rateLimit.allowed) return limited(rateLimit);
    if (Number(request.headers.get("content-length") ?? 0) > maximumBodyBytes) {
      return json({ error: "REQUEST_TOO_LARGE", message: "The form is too large." }, { status: 413 }, rateLimit);
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > maximumBodyBytes) {
      return json({ error: "REQUEST_TOO_LARGE", message: "The form is too large." }, { status: 413 }, rateLimit);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: "INVALID_JSON_BODY", message: "Send a JSON request body." }, { status: 400 }, rateLimit);
    }
    const { answers } = publicSubmitSchema.parse(parsed);
    const result = await submitClubFormViaLink(token, answers);
    // The submission id stays inside; the filler only needs to know it worked.
    return json({ ok: true, confirmationMessage: result.confirmationMessage }, { status: 201 }, rateLimit);
  } catch (error) {
    return failure(error, "Submitting a club form", rateLimit);
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
