import { cookies } from "next/headers";
import { logError, logInfo } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import {
  exchangeGoogleAuthorizationCode,
  isGoogleSignInConfigured,
  verifyGoogleIdToken,
} from "@/integrations/oauth/google";
import { signInWithGoogle } from "@/modules/attendee-accounts/federated-sign-in";
import {
  mutableRedirect,
  parseOAuthHandoff,
  stateMatches,
} from "@/modules/attendee-accounts/oauth-handoff";
import { attendeePublicUrl } from "@/modules/attendee-accounts/public-navigation";
import {
  ATTENDEE_OAUTH_COOKIE_NAME,
  ATTENDEE_PENDING_COOKIE_NAME,
  ATTENDEE_SESSION_COOKIE_NAME,
  ATTENDEE_SESSION_LIFETIME_SECONDS,
} from "@/modules/attendee-accounts/session-store";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkAttendeeOAuthCallbackRateLimit } from "@/modules/rate-limit/service";

/**
 * Where Google sends the registrant back.
 *
 * Order matters here, and it is: prove the callback belongs to a request this
 * browser made, then spend the handoff, then exchange the code, then verify
 * what came back, and only then touch an account. Nothing before the last step
 * writes anything, so a callback that fails any check leaves no trace.
 */

function back(error: string) {
  return mutableRedirect(
    attendeePublicUrl(`/account/sign-in?error=${encodeURIComponent(error)}`),
    303,
  );
}

async function getHandler(request: Request) {
  const cookieStore = await cookies();
  const handoff = parseOAuthHandoff(cookieStore.get(ATTENDEE_OAUTH_COOKIE_NAME)?.value);

  // Single use, whatever happens next. Leaving it live would let a failed or
  // intercepted attempt be retried against the same state and verifier.
  cookieStore.set(ATTENDEE_OAUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/attendee/oauth",
    maxAge: 0,
  });

  let rateLimit: RateLimitOutcome | undefined;
  try {
    if (!isGoogleSignInConfigured()) return back("google-unavailable");

    rateLimit = await checkAttendeeOAuthCallbackRateLimit(request);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(back("rate-limited"), rateLimit);
    }

    const url = new URL(request.url);
    // Someone who declines the Google consent screen arrives here too. That is
    // a decision, not a fault, so it goes back quietly.
    const denied = url.searchParams.get("error");
    if (denied) return applyRateLimitHeaders(back("google-cancelled"), rateLimit);

    if (!handoff || !stateMatches(url.searchParams.get("state"), handoff.state)) {
      return applyRateLimitHeaders(back("google-expired"), rateLimit);
    }

    const code = url.searchParams.get("code");
    if (!code) return applyRateLimitHeaders(back("google-failed"), rateLimit);

    const idToken = await exchangeGoogleAuthorizationCode(code, handoff.codeVerifier);
    const identity = await verifyGoogleIdToken(idToken, handoff.nonce);

    const result = await signInWithGoogle(identity, request.headers.get("user-agent"));
    if (result.outcome === "refused") {
      return applyRateLimitHeaders(back(`google-${result.reason}`), rateLimit);
    }

    cookieStore.set(ATTENDEE_SESSION_COOKIE_NAME, result.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: result.session.expiresAt,
      maxAge: ATTENDEE_SESSION_LIFETIME_SECONDS,
      priority: "high",
    });
    // A password sign-up that was mid-flight in this browser is over.
    cookieStore.delete(ATTENDEE_PENDING_COOKIE_NAME);

    logInfo("An attendee signed in with Google.", { linkage: result.linkage });
    return applyRateLimitHeaders(
      mutableRedirect(attendeePublicUrl("/account")),
      rateLimit,
    );
  } catch (error) {
    logError("Google sign-in could not be completed", error);
    const response = back("google-failed");
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const GET = withRequestContext(getHandler);
