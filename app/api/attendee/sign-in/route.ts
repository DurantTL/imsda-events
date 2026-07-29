import { cookies } from "next/headers";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { authenticateAttendee } from "@/modules/attendee-accounts/account-service";
import {
  ATTENDEE_SESSION_COOKIE_NAME,
  ATTENDEE_SESSION_LIFETIME_SECONDS,
} from "@/modules/attendee-accounts/session-store";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkAttendeeSignInRateLimit } from "@/modules/rate-limit/service";

/**
 * Password sign-in for a registrant. Separate from `/api/auth/login` by
 * decision, not by accident: that route resolves staff, carries the MFA gate
 * that protects roster export and sensitive data, and sets a different cookie.
 * Nothing an account here holds can satisfy it.
 */

const signInSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

const REFUSAL = {
  error: "INVALID_CREDENTIALS",
  message: "The email or password is incorrect, or the account is not ready to sign in yet.",
};

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const input = signInSchema.parse(await request.json());
    rateLimit = await checkAttendeeSignInRateLimit(request, input.email);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many sign-in attempts. Try again later.",
      }, { status: 429 }), rateLimit);
    }

    const authentication = await authenticateAttendee(
      input.email,
      input.password,
      request.headers.get("user-agent"),
    );
    // An unverified account is refused here in the same words as a wrong
    // password. Saying "verify your email first" would confirm the address is
    // known and that a sign-up for it is outstanding.
    if (!authentication) {
      return applyRateLimitHeaders(Response.json(REFUSAL, { status: 401 }), rateLimit);
    }

    (await cookies()).set(ATTENDEE_SESSION_COOKIE_NAME, authentication.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: authentication.session.expiresAt,
      maxAge: ATTENDEE_SESSION_LIFETIME_SECONDS,
      priority: "high",
    });
    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({
        error: "INVALID_SIGN_IN",
        message: "Enter a valid email address and password.",
      }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Attendee sign-in failed", error);
    const response = Response.json({
      error: "SIGN_IN_FAILED",
      message: "Sign-in is temporarily unavailable.",
    }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
