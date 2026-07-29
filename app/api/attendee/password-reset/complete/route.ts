import { cookies } from "next/headers";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { hashPassword, validateChosenPassword } from "@/modules/access/passwords";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { completeAttendeePasswordReset } from "@/modules/attendee-accounts/account-service";
import {
  ATTENDEE_PENDING_COOKIE_NAME,
  ATTENDEE_SESSION_COOKIE_NAME,
  ATTENDEE_SESSION_LIFETIME_SECONDS,
} from "@/modules/attendee-accounts/session-store";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkAttendeeVerificationRateLimit } from "@/modules/rate-limit/service";

/**
 * Spends a reset code and sets the new password.
 *
 * Both halves are required, as everywhere else in this feature: the code from
 * the inbox, and the pending cookie held only by the browser that asked. The
 * new password is validated before the code is spent, so someone who chooses a
 * password the policy refuses does not lose their one code to it.
 */

const completeSchema = z.object({
  code: z.string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().min(1).max(32)),
  password: z.string().min(1).max(128),
});

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    rateLimit = await checkAttendeeVerificationRateLimit(request);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many attempts. Try again later.",
      }, { status: 429 }), rateLimit);
    }

    const cookieStore = await cookies();
    const pendingToken = cookieStore.get(ATTENDEE_PENDING_COOKIE_NAME)?.value;
    const input = completeSchema.parse(await request.json());

    // Checked first, and deliberately: the policy's answer names the rule that
    // was broken, which helps the person and tells a stranger nothing about
    // whether the code or the account was real.
    const passwordError = await validateChosenPassword(input.password);
    if (passwordError) {
      return applyRateLimitHeaders(Response.json({
        error: "WEAK_PASSWORD",
        message: passwordError,
      }, { status: 400 }), rateLimit);
    }

    const result = pendingToken
      ? await completeAttendeePasswordReset({
        pendingToken,
        code: input.code,
        passwordHash: await hashPassword(input.password),
        userAgent: request.headers.get("user-agent"),
      })
      : { outcome: "rejected" as const };

    // A missing cookie and a wrong code are the same event to the caller.
    if (result.outcome === "rejected") {
      return applyRateLimitHeaders(Response.json({
        error: "INVALID_CODE",
        message: "That code is not right, or it has expired. Request a new one to try again.",
      }, { status: 400 }), rateLimit);
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
    cookieStore.delete(ATTENDEE_PENDING_COOKIE_NAME);

    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({
        error: "INVALID_CODE",
        message: "Enter the six-digit code from your email and a new password.",
      }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Attendee password reset failed", error);
    const response = Response.json({
      error: "RESET_FAILED",
      message: "Password reset is temporarily unavailable.",
    }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
