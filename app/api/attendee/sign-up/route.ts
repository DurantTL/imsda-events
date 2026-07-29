import { cookies } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { validateChosenPassword } from "@/modules/access/passwords";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { beginAttendeeSignUp } from "@/modules/attendee-accounts/account-service";
import { ATTENDEE_PENDING_REQUEST_LIFETIME_HOURS } from "@/modules/attendee-accounts/codes";
import { ATTENDEE_PENDING_COOKIE_NAME } from "@/modules/attendee-accounts/session-store";
import {
  deliverQueuedAttendeeEmail,
  queueAttendeeVerificationEmail,
} from "@/modules/attendee-accounts/attendee-email-dispatch";
import { mintAttendeeCodeWithoutSending } from "@/modules/attendee-accounts/attendee-email";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkAttendeeSignUpRateLimit } from "@/modules/rate-limit/service";

/**
 * Starts an attendee account (ADR 0003).
 *
 * The response says the same thing however it went. Sign-up is public and
 * unauthenticated, and "an account exists for this address" is not something a
 * stranger may learn from it — so an address that is already registered gets the
 * same status, the same body, and a pending cookie of its own. What differs is
 * only what arrives in the inbox, which is the one place the distinction is safe
 * to draw.
 */

const signUpSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(128),
});

const SAME_ANSWER = {
  ok: true as const,
  message: "Check your email for a six-digit code, then enter it below.",
};

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const input = signUpSchema.parse(await request.json());

    rateLimit = await checkAttendeeSignUpRateLimit(request, input.email);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many sign-up attempts for this address. Try again later.",
      }, { status: 429 }), rateLimit);
    }

    // The password rules are the platform's, and they are stated plainly: this
    // is the one part of sign-up where a specific answer helps the person and
    // discloses nothing about anybody else.
    const passwordError = await validateChosenPassword(input.password, {
      email: input.email,
      displayName: input.displayName,
    });
    if (passwordError) {
      return applyRateLimitHeaders(Response.json({
        error: "WEAK_PASSWORD",
        message: passwordError,
      }, { status: 400 }), rateLimit);
    }

    const signUp = await beginAttendeeSignUp(input);
    const dispatch = await queueAttendeeVerificationEmail({
      accountId: signUp.accountId,
      email: input.email,
      displayName: input.displayName,
      alreadyRegistered: signUp.outcome === "existing",
    });
    if (dispatch.messageId) {
      after(() => deliverQueuedAttendeeEmail(dispatch.messageId!));
    }

    (await cookies()).set(ATTENDEE_PENDING_COOKIE_NAME, signUp.pendingToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: signUp.expiresAt,
      maxAge: ATTENDEE_PENDING_REQUEST_LIFETIME_HOURS * 60 * 60,
      priority: "high",
    });

    // Development fallback, matching the password-reset route: without account
    // email configured there is no way to obtain a code at all, and a sign-up
    // nobody can finish is not a testable one. Never for an address that is
    // already registered — that code would hand over someone else's account.
    const developmentCode = !dispatch.configured
      && process.env.NODE_ENV !== "production"
      && signUp.outcome !== "existing"
      ? await mintAttendeeCodeWithoutSending({ accountId: signUp.accountId, purpose: "verification" })
      : null;

    return applyRateLimitHeaders(
      Response.json({ ...SAME_ANSWER, developmentCode: developmentCode ?? undefined }),
      rateLimit,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({
        error: "INVALID_SIGN_UP",
        message: "Enter your name, a valid email address, and a password.",
      }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Attendee sign-up failed", error);
    const response = Response.json({
      error: "SIGN_UP_FAILED",
      message: "Creating an account is temporarily unavailable.",
    }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
