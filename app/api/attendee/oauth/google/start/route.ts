import { cookies } from "next/headers";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import {
  beginGoogleAuthorization,
  isGoogleSignInConfigured,
} from "@/integrations/oauth/google";
import { ATTENDEE_OAUTH_COOKIE_NAME } from "@/modules/attendee-accounts/session-store";
import {
  mutableRedirect,
  OAUTH_HANDOFF_LIFETIME_SECONDS,
} from "@/modules/attendee-accounts/oauth-handoff";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkAttendeeOAuthStartRateLimit } from "@/modules/rate-limit/service";

/**
 * Sends a registrant to Google.
 *
 * A GET, because it is a top-level navigation the browser performs — which is
 * why there is no origin check here. Nothing is mutated: this route hands out
 * three single-use secrets and a redirect, and the callback is where anything
 * is decided. The secrets go into one short-lived httpOnly cookie so the
 * callback can prove the response belongs to a request this browser made.
 */
async function getHandler(request: Request) {
  let rateLimit: RateLimitOutcome | undefined;
  try {
    if (!isGoogleSignInConfigured()) {
      // Sign-in pages hide the button when this is the case, so reaching here
      // means a stale tab or a hand-typed URL.
      return mutableRedirect(new URL("/account/sign-in?error=google-unavailable", request.url));
    }

    rateLimit = await checkAttendeeOAuthStartRateLimit(request);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        mutableRedirect(new URL("/account/sign-in?error=rate-limited", request.url)),
        rateLimit,
      );
    }

    const authorization = beginGoogleAuthorization();
    (await cookies()).set(
      ATTENDEE_OAUTH_COOKIE_NAME,
      JSON.stringify({
        state: authorization.state,
        nonce: authorization.nonce,
        codeVerifier: authorization.codeVerifier,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        // Lax, not Strict: the browser arrives back from Google as a top-level
        // navigation, and Strict would withhold the cookie on exactly that hop.
        sameSite: "lax",
        path: "/api/attendee/oauth",
        maxAge: OAUTH_HANDOFF_LIFETIME_SECONDS,
        priority: "high",
      },
    );

    return applyRateLimitHeaders(
      mutableRedirect(authorization.authorizationUrl),
      rateLimit,
    );
  } catch (error) {
    logError("Google sign-in could not be started", error);
    const response = mutableRedirect(
      new URL("/account/sign-in?error=google-failed", request.url),
      303,
    );
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const GET = withRequestContext(getHandler);
