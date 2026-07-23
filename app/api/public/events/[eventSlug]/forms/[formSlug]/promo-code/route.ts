import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  getPublicPromoCodeQuote,
  PublicPromoCodeError,
} from "@/modules/promo-codes/repository";
import { publicPromoCodeQuoteInputSchema } from "@/modules/promo-codes/schemas";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicPromoQuoteRateLimit } from "@/modules/rate-limit/service";

const maximumBodyBytes = 512 * 1024;
const noStoreHeaders = { "Cache-Control": "no-store" };

function promoQuoteError(error: unknown, rateLimit?: RateLimitOutcome) {
  let response: Response;
  if (error instanceof z.ZodError) {
    response = Response.json(
      {
        error: "INVALID_REQUEST",
        message: error.issues[0]?.message ?? "Review the promo code.",
      },
      { status: 400, headers: noStoreHeaders },
    );
  } else if (error instanceof SyntaxError) {
    response = Response.json(
      { error: "INVALID_JSON", message: "The promo-code request is not valid JSON." },
      { status: 400, headers: noStoreHeaders },
    );
  } else if (error instanceof PublicPromoCodeError) {
    const status = error.reason === "FORM_NOT_FOUND" ? 404 : 422;
    response = Response.json(
      {
        error: error.reason,
        message: error.message,
        issue: {
          key: "promo_code",
          fieldId: error.fieldId,
          path: "responses.promo_code",
          attendeeIndex: null,
          message: error.message,
        },
      },
      { status, headers: noStoreHeaders },
    );
  } else {
    console.error(
      "Public promo-code quote failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    response = Response.json(
      {
        error: "PROMO_QUOTE_FAILED",
        message: "The promo code could not be checked right now. Try again.",
      },
      { status: 500, headers: noStoreHeaders },
    );
  }
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ eventSlug: string; formSlug: string }>;
  },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { eventSlug, formSlug } = await context.params;
    rateLimit = await checkPublicPromoQuoteRateLimit(
      request,
      eventSlug,
      formSlug,
    );
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json(
        {
          error: "RATE_LIMITED",
          message: "Too many promo-code checks. Wait a few minutes and try again.",
        },
        { status: 429, headers: noStoreHeaders },
      ), rateLimit);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return applyRateLimitHeaders(Response.json(
        { error: "REQUEST_TOO_LARGE", message: "This request is too large." },
        { status: 413, headers: noStoreHeaders },
      ), rateLimit);
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
      return applyRateLimitHeaders(Response.json(
        { error: "REQUEST_TOO_LARGE", message: "This request is too large." },
        { status: 413, headers: noStoreHeaders },
      ), rateLimit);
    }
    const input = publicPromoCodeQuoteInputSchema.parse(JSON.parse(body));
    const quote = await getPublicPromoCodeQuote(
      eventSlug,
      formSlug,
      input,
    );
    return applyRateLimitHeaders(
      Response.json({ quote }, { headers: noStoreHeaders }),
      rateLimit,
    );
  } catch (error) {
    return promoQuoteError(error, rateLimit);
  }
}

