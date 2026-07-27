import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  confirmPublicRegistrationShirtSizes,
  PublicShirtSizeConfirmationError,
} from "@/modules/public-access/repository";
import {
  publicShirtSizeConfirmationSchema,
} from "@/modules/registrations/shirt-sizes";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

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

function applyPrivateHeaders(response: Response) {
  Object.entries(privateHeaders).forEach(([name, value]) => {
    response.headers.set(name, value);
  });
  return response;
}

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

function errorResponse(error: unknown, rateLimit?: RateLimitOutcome) {
  if (error instanceof z.ZodError) {
    return json(
      {
        error: "INVALID_SHIRT_SIZES",
        message: error.issues[0]?.message
          ?? "Review every attendee shirt size and try again.",
        issues: error.issues,
      },
      { status: 400 },
      rateLimit,
    );
  }
  if (error instanceof PublicShirtSizeConfirmationError) {
    return json(
      { error: error.code, message: error.message },
      { status: 409 },
      rateLimit,
    );
  }
  if (error instanceof SyntaxError) {
    return json(
      {
        error: "INVALID_JSON",
        message: "The shirt-size confirmation is not valid JSON.",
      },
      { status: 400 },
      rateLimit,
    );
  }
  logError("Private shirt-size confirmation failed.", error);
  return json(
    {
      error: "SHIRT_SIZE_CONFIRMATION_FAILED",
      message: "The shirt sizes could not be saved. Try again in a moment.",
    },
    { status: 500 },
    rateLimit,
  );
}

async function patchHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return applyPrivateHeaders(originError);

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "update");
    if (!rateLimit.allowed) {
      return json(
        {
          error: "RATE_LIMITED",
          message: "Too many updates for this private registration link. Try again later.",
        },
        { status: 429 },
        rateLimit,
      );
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return json(
        {
          error: "REQUEST_TOO_LARGE",
          message: "The shirt-size confirmation is too large.",
        },
        { status: 413 },
        rateLimit,
      );
    }

    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
      return json(
        {
          error: "REQUEST_TOO_LARGE",
          message: "The shirt-size confirmation is too large.",
        },
        { status: 413 },
        rateLimit,
      );
    }

    const input = publicShirtSizeConfirmationSchema.parse(JSON.parse(body));
    const registration = await confirmPublicRegistrationShirtSizes(
      token,
      input,
    );
    return registration
      ? json({ registration }, undefined, rateLimit)
      : json(
          {
            error: "REGISTRATION_ACCESS_UNAVAILABLE",
            message: "This private registration link is invalid or no longer active.",
          },
          { status: 404 },
          rateLimit,
        );
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}

export const PATCH = withRequestContext(patchHandler);
