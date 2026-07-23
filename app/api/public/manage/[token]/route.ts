import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { publicContactUpdateSchema } from "@/modules/public-access/domain";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import {
  resolveRegistrationAccessToken,
  updatePublicRegistrationContactWithMessages,
} from "@/modules/public-access/repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

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

function unavailableResponse(rateLimit?: RateLimitOutcome) {
  return json(
    {
      error: "REGISTRATION_ACCESS_UNAVAILABLE",
      message: "This private registration link is invalid or no longer active.",
    },
    { status: 404 },
    rateLimit,
  );
}

function errorResponse(error: unknown, rateLimit?: RateLimitOutcome) {
  if (error instanceof z.ZodError) {
    return json(
      {
        error: "INVALID_CONTACT",
        message: error.issues[0]?.message ?? "Review the contact details and try again.",
        issues: error.issues,
      },
      { status: 400 },
      rateLimit,
    );
  }
  if (error instanceof SyntaxError) {
    return json(
      {
        error: "INVALID_JSON",
        message: "The contact update is not valid JSON.",
      },
      { status: 400 },
      rateLimit,
    );
  }

  console.error(
    "Private registration access request failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json(
    {
      error: "REGISTRATION_ACCESS_FAILED",
      message: "The registration could not be loaded. Try again in a moment.",
    },
    { status: 500 },
    rateLimit,
  );
}

export async function GET(request: Request, context: RouteContext) {
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "read");
    if (!rateLimit.allowed) {
      return json(
        {
          error: "RATE_LIMITED",
          message: "Too many requests for this private registration link. Try again later.",
        },
        { status: 429 },
        rateLimit,
      );
    }
    const registration = await resolveRegistrationAccessToken(token);
    return registration
      ? json({ registration }, undefined, rateLimit)
      : unavailableResponse(rateLimit);
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
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
          message: "The contact update is too large.",
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
          message: "The contact update is too large.",
        },
        { status: 413 },
        rateLimit,
      );
    }

    const input = publicContactUpdateSchema.parse(JSON.parse(body));
    const result = await updatePublicRegistrationContactWithMessages(token, input);
    if (result) {
      try {
        await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
      } catch (error) {
        console.error(
          "Contact-update message processing failed after the registration commit",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    return result
      ? json({ registration: result.registration }, undefined, rateLimit)
      : unavailableResponse(rateLimit);
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}
