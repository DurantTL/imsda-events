import { cookies } from "next/headers";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { beginAttendeePasswordReset } from "@/modules/attendee-accounts/account-service";
import { EMAIL_VERIFICATION_LIFETIME_MINUTES } from "@/modules/attendee-accounts/codes";
import { ATTENDEE_PENDING_COOKIE_NAME } from "@/modules/attendee-accounts/session-store";
import { sendAttendeePasswordResetEmail } from "@/modules/attendee-accounts/attendee-email-dispatch";
import { mintAttendeeCodeWithoutSending } from "@/modules/attendee-accounts/attendee-email";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkAttendeePasswordResetRateLimit } from "@/modules/rate-limit/service";

/**
 * Asks for a password reset code.
 *
 * Like sign-up, the answer never varies. Three quite different things can
 * happen behind it — a code is sent, a "you sign in with Google" note is sent,
 * or nothing is sent at all — and which one it was is precisely what a stranger
 * may not learn. The pending cookie is set in every case, so even the presence
 * of one discloses nothing.
 */

const requestSchema = z.object({ email: z.string().trim().email().max(254) });

const SAME_ANSWER = {
  ok: true as const,
  message: "If that address has an account, a six-digit code is on its way.",
};

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const input = requestSchema.parse(await request.json());

    rateLimit = await checkAttendeePasswordResetRateLimit(request, input.email);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many reset requests for this address. Try again later.",
      }, { status: 429 }), rateLimit);
    }

    const reset = await beginAttendeePasswordReset({ email: input.email });

    let configured = true;
    if (reset.accountId && reset.outcome !== "no-account") {
      const dispatch = await sendAttendeePasswordResetEmail({
        accountId: reset.accountId,
        email: input.email,
        displayName: reset.displayName,
        federatedOnly: reset.outcome === "federated-only",
      });
      configured = dispatch.configured;
    }

    (await cookies()).set(ATTENDEE_PENDING_COOKIE_NAME, reset.pendingToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: reset.expiresAt,
      maxAge: EMAIL_VERIFICATION_LIFETIME_MINUTES * 60,
      priority: "high",
    });

    // Development fallback, as on sign-up: with no account email configured
    // there is no way to obtain a code, and a reset nobody can finish is not a
    // testable one. Only ever for an account that would really have been sent
    // one — never for an unknown address or a Google-only account.
    const developmentCode = !configured
      && process.env.NODE_ENV !== "production"
      && reset.outcome === "issued"
      && reset.accountId
      ? await mintAttendeeCodeWithoutSending({
        accountId: reset.accountId,
        purpose: "password-reset",
      })
      : null;

    return applyRateLimitHeaders(
      Response.json({ ...SAME_ANSWER, developmentCode: developmentCode ?? undefined }),
      rateLimit,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({
        error: "INVALID_EMAIL",
        message: "Enter a valid email address.",
      }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Attendee password reset request failed", error);
    const response = Response.json({
      error: "RESET_REQUEST_FAILED",
      message: "Password reset is temporarily unavailable.",
    }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
