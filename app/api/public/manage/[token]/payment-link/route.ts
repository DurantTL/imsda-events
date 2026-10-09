import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { squarePaymentLinkInputSchema } from "@/modules/payments/square-domain";
import { createPublicSquarePaymentLink } from "@/modules/payments/square-hosted-repository";
import { SquarePaymentOperationError } from "@/modules/payments/square-repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicPaymentRateLimit } from "@/modules/rate-limit/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const maximumBodyBytes = 4 * 1_024;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type RouteContext = { params: Promise<{ token: string }> };

function json(body: unknown, init?: ResponseInit, rateLimit?: RateLimitOutcome) {
  const response = Response.json(body, {
    ...init,
    headers: { ...privateHeaders, ...init?.headers },
  });
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

function errorResponse(error: unknown, rateLimit?: RateLimitOutcome) {
  if (error instanceof z.ZodError) {
    return json({
      error: "INVALID_PAYMENT_REQUEST",
      message: error.issues[0]?.message ?? "The payment link request is invalid.",
    }, { status: 400 }, rateLimit);
  }
  if (error instanceof SyntaxError) {
    return json({
      error: "INVALID_JSON",
      message: "The payment link request is not valid JSON.",
    }, { status: 400 }, rateLimit);
  }
  if (error instanceof SquarePaymentOperationError) {
    const status = error.code === "REGISTRATION_ACCESS_UNAVAILABLE"
      ? 404
      : error.code === "SQUARE_NOT_CONFIGURED"
        || error.code === "PAYMENT_RESULT_UNCERTAIN"
        || error.code === "PAYMENT_OPERATION_CONFLICT"
        ? 503
        : error.code === "PAYMENT_ATTEMPT_FAILED"
          ? 422
          : 409;
    return json({
      error: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    }, { status }, rateLimit);
  }
  logError("Private Pay on Square link request failed.", error);
  return json({
    error: "SQUARE_PAYMENT_LINK_FAILED",
    message: "The Pay on Square link could not be created. Your registration is still saved.",
    retryable: false,
  }, { status: 500 }, rateLimit);
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) {
    Object.entries(privateHeaders).forEach(([name, value]) => {
      originError.headers.set(name, value);
    });
    return originError;
  }
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicPaymentRateLimit(request, token);
    if (!rateLimit.allowed) {
      return json({
        error: "RATE_LIMITED",
        message: "Too many payment attempts. Try again later.",
      }, { status: 429 }, rateLimit);
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The payment link request is too large.",
      }, { status: 413 }, rateLimit);
    }
    const input = squarePaymentLinkInputSchema.parse(JSON.parse(rawBody));
    const link = await createPublicSquarePaymentLink(token, input);
    return json({ link }, { status: 200 }, rateLimit);
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}

export const POST = withRequestContext(postHandler);
