import { z } from "zod";
import { logError } from "@/lib/logger";
import {
  MfaError,
  beginEnrollmentFromChallenge,
  completeMfaChallenge,
  describeMfaChallenge,
} from "@/modules/access/mfa-service";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_SECONDS } from "@/modules/access/session-store";
import { cookies } from "next/headers";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkLoginClientRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

/**
 * The second half of sign-in.
 *
 * The challenge token is the only credential here: it is proof that a password
 * was accepted moments ago, is single-use, expires in ten minutes, and is
 * stored as a digest. It is not a session and cannot be used as one.
 */

const challengeSchema = z.object({
  challengeToken: z.string().min(32).max(256),
  action: z.enum(["describe", "begin-enrollment", "verify"]),
  code: z.string().trim().min(1).max(32).optional(),
});

function mfaErrorResponse(error: MfaError) {
  const status = error.code === "MFA_CHALLENGE_INVALID" ? 401 : 400;
  return Response.json({ error: error.code, message: error.message }, { status });
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    // Shares the sign-in bucket: guessing a six-digit code is a sign-in attempt.
    rateLimit = await checkLoginClientRateLimit(request);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json(
        { error: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." },
        { status: 429 },
      ), rateLimit);
    }

    const input = challengeSchema.parse(await request.json());

    if (input.action === "describe") {
      const described = await describeMfaChallenge(input.challengeToken);
      return applyRateLimitHeaders(Response.json(described), rateLimit);
    }

    if (input.action === "begin-enrollment") {
      const offer = await beginEnrollmentFromChallenge(input.challengeToken);
      return applyRateLimitHeaders(Response.json(offer), rateLimit);
    }

    if (!input.code) {
      return applyRateLimitHeaders(Response.json(
        { error: "MFA_CODE_INVALID", message: "Enter the six-digit code from your authenticator." },
        { status: 400 },
      ), rateLimit);
    }

    const result = await completeMfaChallenge(input.challengeToken, input.code, {
      userAgent: request.headers.get("user-agent"),
    });
    (await cookies()).set(SESSION_COOKIE_NAME, result.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: result.session.expiresAt,
      maxAge: SESSION_LIFETIME_SECONDS,
      priority: "high",
    });
    return applyRateLimitHeaders(Response.json({
      ok: true,
      usedRecoveryCode: result.usedRecoveryCode,
      recoveryCodes: result.recoveryCodes,
    }), rateLimit);
  } catch (error) {
    if (error instanceof MfaError) {
      const response = mfaErrorResponse(error);
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    if (error instanceof z.ZodError) {
      const response = Response.json(
        { error: "INVALID_REQUEST", message: "That sign-in step could not be completed." },
        { status: 400 },
      );
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("MFA challenge failed", error);
    const response = Response.json(
      { error: "MFA_FAILED", message: "Sign-in is temporarily unavailable." },
      { status: 500 },
    );
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
