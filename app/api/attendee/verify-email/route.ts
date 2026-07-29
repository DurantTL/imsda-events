import { cookies } from "next/headers";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { verifyAttendeeEmail } from "@/modules/attendee-accounts/account-service";
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
 * Spends an emailed verification code and signs the account in.
 *
 * Both halves are required and neither is enough: the code arrives in the
 * inbox being claimed, and the pending cookie is held only by the browser that
 * started the sign-up. That is why the code is a code and not a link — a link
 * would be spendable by whoever opened it, including the address's real owner
 * clicking to find out what an unexpected email was.
 */

const verifySchema = z.object({
  // Whitespace out of the middle too. "123 456" is what the email shows, so it
  // is what a password manager hands over — the same rule the MFA routes apply.
  code: z.string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().min(1).max(32)),
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
    const input = verifySchema.parse(await request.json());

    // A missing cookie and a wrong code are the same event to the caller. Saying
    // "start again" for one and "wrong code" for the other would tell someone
    // holding only a forwarded code that the code itself was good.
    const verification = pendingToken
      ? await verifyAttendeeEmail({
        pendingToken,
        code: input.code,
        userAgent: request.headers.get("user-agent"),
      })
      : { outcome: "rejected" as const };

    if (verification.outcome === "rejected") {
      return applyRateLimitHeaders(Response.json({
        error: "INVALID_CODE",
        message: "That code is not right, or it has expired. Request a new one to try again.",
      }, { status: 400 }), rateLimit);
    }

    cookieStore.set(ATTENDEE_SESSION_COOKIE_NAME, verification.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: verification.session.expiresAt,
      maxAge: ATTENDEE_SESSION_LIFETIME_SECONDS,
      priority: "high",
    });
    cookieStore.delete(ATTENDEE_PENDING_COOKIE_NAME);

    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({
        error: "INVALID_CODE",
        message: "Enter the six-digit code from your email.",
      }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Attendee email verification failed", error);
    const response = Response.json({
      error: "VERIFICATION_FAILED",
      message: "Verification is temporarily unavailable.",
    }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
