import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { AttendeeAnswerUpdateError } from "@/modules/attendee-accounts/registration-answer-policy";
import { updatePublicTieredAttendeeAnswers } from "@/modules/public-access/repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

const maximumBodyBytes = 64 * 1_024;
const attendeeSchema = z.strictObject({
  attendeeId: z.string().trim().min(1).max(100),
  responses: z.record(z.string().trim().min(1).max(80), z.unknown()),
});
const inputSchema = z.strictObject({
  clientRequestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  attendees: z.array(attendeeSchema).min(1).max(50),
});
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type Context = { params: Promise<{ token: string }> };

function json(
  body: unknown,
  init?: ResponseInit,
  rateLimit?: RateLimitOutcome,
) {
  const response = Response.json(body, {
    ...init,
    headers: { ...privateHeaders, ...init?.headers },
  });
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
      return json({
        error: "RATE_LIMITED",
        message: "Too many updates for this private registration link. Try again later.",
      }, { status: 429 }, rateLimit);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The attendee choice update is too large.",
      }, { status: 413 }, rateLimit);
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The attendee choice update is too large.",
      }, { status: 413 }, rateLimit);
    }
    const input = inputSchema.parse(JSON.parse(body));
    const result = await updatePublicTieredAttendeeAnswers(token, input);
    if (!result) {
      return json({
        error: "REGISTRATION_ACCESS_UNAVAILABLE",
        message: "This private registration link is invalid or no longer active.",
      }, { status: 404 }, rateLimit);
    }
    return json(result, undefined, rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return json({
        error: "INVALID_REQUEST",
        message: error instanceof z.ZodError
          ? error.issues[0]?.message ?? "Review the choices and try again."
          : "The attendee choice update is not valid JSON.",
      }, { status: 400 }, rateLimit);
    }
    if (error instanceof AttendeeAnswerUpdateError) {
      const status = error.code === "EDIT_POLICY_REQUIRES_VERIFICATION"
        ? 403
        : error.code === "SEMINAR_PREFERENCES_LOCKED"
          || error.code === "FINAL_ASSIGNMENT_LOCKED"
          || error.code === "IDEMPOTENCY_KEY_REUSED"
          ? 409
          : 400;
      return json(
        { error: error.code, message: error.message },
        { status },
        rateLimit,
      );
    }
    logError("Private registration attendee choice update failed.", error);
    return json({
      error: "ATTENDEE_ANSWER_UPDATE_FAILED",
      message: "The attendee choices could not be saved. Try again in a moment.",
    }, { status: 500 }, rateLimit);
  }
}

export const PUT = withRequestContext(putHandler);
