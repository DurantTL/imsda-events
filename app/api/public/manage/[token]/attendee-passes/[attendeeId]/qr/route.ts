import QRCode from "qrcode";
import { createAuthorizedAttendeePass } from "@/modules/checkin/attendee-pass-repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicManageRateLimit } from "@/modules/rate-limit/service";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type RouteContext = {
  params: Promise<{ token: string; attendeeId: string }>;
};

function privateJson(
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

export async function GET(request: Request, context: RouteContext) {
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { token, attendeeId } = await context.params;
    rateLimit = await checkPublicManageRateLimit(request, token, "read");
    if (!rateLimit.allowed) {
      return privateJson({
        error: "RATE_LIMITED",
        message: "Too many attendee pass requests. Try again later.",
      }, { status: 429 }, rateLimit);
    }

    const pass = await createAuthorizedAttendeePass(token, attendeeId);
    if (!pass) {
      return privateJson({
        error: "ATTENDEE_PASS_UNAVAILABLE",
        message: "This attendee pass is invalid or no longer available.",
      }, { status: 404 }, rateLimit);
    }

    const svg = await QRCode.toString(pass.token, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: {
        dark: "#003b5cff",
        light: "#ffffffff",
      },
    });
    const response = new Response(svg, {
      headers: {
        ...privateHeaders,
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": "inline; filename=\"imsda-attendee-pass.svg\"",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
    return applyRateLimitHeaders(response, rateLimit);
  } catch (error) {
    console.error(
      "Private attendee pass rendering failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return privateJson({
      error: "ATTENDEE_PASS_RENDER_FAILED",
      message: "The attendee pass could not be displayed. Try again.",
    }, { status: 500 }, rateLimit);
  }
}
