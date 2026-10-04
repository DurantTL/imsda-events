import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { PublicResponsibleAdultError, updatePublicResponsibleAdults } from "@/modules/public-access/repository";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

/**
 * The registrant changes who is responsible for their minors (#131) from the private registration page. The
 * token names the registration; only that registration's own attendees can be chosen. Same-origin only.
 */

const maximumBodyBytes = 8 * 1_024;
const inputSchema = z.strictObject({
  choices: z.record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(100)),
}).refine((value) => Object.keys(value.choices).length <= 50, "Too many choices.");
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
      return json({ error: "REQUEST_TOO_LARGE", message: "The responsible-adult update is too large." }, { status: 413 }, rateLimit);
    }
    const input = inputSchema.parse(JSON.parse(body));
    const result = await updatePublicResponsibleAdults(token, input.choices);
    if (!result) {
      return json({ error: "REGISTRATION_ACCESS_UNAVAILABLE", message: "This private registration link is invalid or no longer active." }, { status: 404 }, rateLimit);
    }
    return json(result, undefined, rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return json({
        error: "INVALID_REQUEST",
        message: error instanceof z.ZodError ? error.issues[0]?.message ?? "Review the choices and try again." : "The update is not valid JSON.",
      }, { status: 400 }, rateLimit);
    }
    if (error instanceof PublicResponsibleAdultError) {
      return json({ error: error.code, message: error.message }, { status: error.code === "CHOICES_INVALID" ? 422 : 409 }, rateLimit);
    }
    logError("Private responsible-adult update failed.", error);
    return json({ error: "RESPONSIBLE_ADULT_UPDATE_FAILED", message: "The responsible adult could not be saved. Try again in a moment." }, { status: 500 }, rateLimit);
  }
}

export const PUT = withRequestContext(putHandler);
