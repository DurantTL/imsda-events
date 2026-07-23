import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { squarePaymentInputSchema } from "@/modules/payments/square-domain";
import {
  createPublicSquarePayment,
  getPublicSquareCheckout,
  SquarePaymentOperationError,
} from "@/modules/payments/square-repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicPaymentRateLimit } from "@/modules/rate-limit/service";

const maximumBodyBytes = 16 * 1_024;
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

function unavailableResponse() {
  return json({
    error: "REGISTRATION_ACCESS_UNAVAILABLE",
    message: "This private registration link is invalid or no longer active.",
  }, { status: 404 });
}

function operationErrorResponse(
  error: SquarePaymentOperationError,
  rateLimit?: RateLimitOutcome,
) {
  const status = error.code === "REGISTRATION_ACCESS_UNAVAILABLE"
    ? 404
    : error.code === "SQUARE_NOT_CONFIGURED"
      ? 503
      : error.code === "PAYMENT_DECLINED"
        || error.code === "PAYMENT_ATTEMPT_FAILED"
        ? 422
        : error.code === "PAYMENT_RESULT_UNCERTAIN"
          || error.code === "PAYMENT_OPERATION_CONFLICT"
          ? 503
          : 409;
  return json({
    error: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  }, { status }, rateLimit);
}

function errorResponse(error: unknown, rateLimit?: RateLimitOutcome) {
  if (error instanceof z.ZodError) {
    return json({
      error: "INVALID_PAYMENT_REQUEST",
      message: error.issues[0]?.message
        ?? "The card payment request is invalid.",
      issues: error.issues,
    }, { status: 400 }, rateLimit);
  }
  if (error instanceof SyntaxError) {
    return json({
      error: "INVALID_JSON",
      message: "The card payment request is not valid JSON.",
    }, { status: 400 }, rateLimit);
  }
  if (error instanceof SquarePaymentOperationError) {
    return operationErrorResponse(error, rateLimit);
  }
  console.error(
    "Private Square payment request failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json({
    error: "SQUARE_PAYMENT_FAILED",
    message: "Online payment could not be completed. Your registration is still saved.",
    retryable: false,
  }, { status: 500 }, rateLimit);
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { token } = await context.params;
    const checkout = await getPublicSquareCheckout(token);
    return checkout ? json({ checkout }) : unavailableResponse();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return applyPrivateHeaders(originError);

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

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The payment request is too large.",
      }, { status: 413 }, rateLimit);
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The payment request is too large.",
      }, { status: 413 }, rateLimit);
    }
    const input = squarePaymentInputSchema.parse(JSON.parse(rawBody));
    const payment = await createPublicSquarePayment(token, input);
    return json(
      { payment },
      { status: payment.status === "PENDING" ? 202 : 200 },
      rateLimit,
    );
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}
