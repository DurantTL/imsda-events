import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { paymentChoiceInputSchema } from "@/modules/payments/payment-choice-domain";
import {
  choosePublicPromotedWaitlistPayment,
  PaymentChoiceOperationError,
} from "@/modules/payments/payment-choice-repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

const maximumBodyBytes = 8 * 1_024;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type RouteContext = {
  params: Promise<{ token: string }>;
};

function json(
  body: unknown,
  init?: ResponseInit,
  rateLimit?: RateLimitOutcome,
) {
  const response = Response.json(body, {
    ...init,
    headers: {
      ...privateHeaders,
      ...init?.headers,
    },
  });
  return rateLimit
    ? applyRateLimitHeaders(response, rateLimit)
    : response;
}

function applyPrivateHeaders(response: Response) {
  Object.entries(privateHeaders).forEach(([name, value]) => {
    response.headers.set(name, value);
  });
  return response;
}

function operationErrorResponse(
  error: PaymentChoiceOperationError,
  rateLimit?: RateLimitOutcome,
) {
  const status = error.code === "REGISTRATION_ACCESS_UNAVAILABLE"
    ? 404
    : error.code === "PAYMENT_CHOICE_OPERATION_CONFLICT"
      ? 503
      : error.code === "PAYMENT_CHOICE_NOT_ELIGIBLE"
        || error.code === "PAYMENT_CHOICE_UNAVAILABLE"
        ? 422
        : 409;
  return json({
    error: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  }, { status }, rateLimit);
}

function errorResponse(
  error: unknown,
  rateLimit?: RateLimitOutcome,
) {
  if (error instanceof z.ZodError) {
    return json({
      error: "INVALID_PAYMENT_CHOICE",
      message: error.issues[0]?.message
        ?? "The payment choice is invalid.",
      issues: error.issues,
    }, { status: 400 }, rateLimit);
  }
  if (error instanceof SyntaxError) {
    return json({
      error: "INVALID_JSON",
      message: "The payment choice request is not valid JSON.",
    }, { status: 400 }, rateLimit);
  }
  if (error instanceof PaymentChoiceOperationError) {
    return operationErrorResponse(error, rateLimit);
  }
  console.error(
    "Promoted waitlist payment-choice request failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json({
    error: "PAYMENT_CHOICE_FAILED",
    message: "The payment choice could not be saved. Your registration is still saved.",
    retryable: false,
  }, { status: 500 }, rateLimit);
}

export async function POST(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return applyPrivateHeaders(originError);

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(
      request,
      token,
      "update",
    );
    if (!rateLimit.allowed) {
      return json({
        error: "RATE_LIMITED",
        message: "Too many payment-choice updates. Try again later.",
      }, { status: 429 }, rateLimit);
    }

    const declaredLength = Number(
      request.headers.get("content-length") ?? 0,
    );
    if (declaredLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The payment choice request is too large.",
      }, { status: 413 }, rateLimit);
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The payment choice request is too large.",
      }, { status: 413 }, rateLimit);
    }
    const input = paymentChoiceInputSchema.parse(JSON.parse(rawBody));
    const paymentChoice = await choosePublicPromotedWaitlistPayment(
      token,
      input,
    );
    return json({ paymentChoice }, undefined, rateLimit);
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}
