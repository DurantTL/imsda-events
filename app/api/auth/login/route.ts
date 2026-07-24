import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateWithPassword } from "@/modules/access/auth-service";
import { issueMfaChallenge } from "@/modules/access/mfa-service";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_SECONDS } from "@/modules/access/session-store";
import { logError } from "@/lib/logger";
import {
  applyRateLimitHeaders,
  mergeRateLimitOutcomes,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import {
  checkLoginAccountRateLimit,
  checkLoginClientRateLimit,
} from "@/modules/rate-limit/service";

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    rateLimit = await checkLoginClientRateLimit(request);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json(
        {
          error: "RATE_LIMITED",
          message: "Too many sign-in attempts. Try again later.",
        },
        { status: 429 },
      ), rateLimit);
    }

    const input = loginSchema.parse(await request.json());
    rateLimit = mergeRateLimitOutcomes(
      rateLimit,
      await checkLoginAccountRateLimit(request, input.email)
    );
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json(
        {
          error: "RATE_LIMITED",
          message: "Too many sign-in attempts. Try again later.",
        },
        { status: 429 },
      ), rateLimit);
    }

    const userAgent = request.headers.get("user-agent");
    const authentication = await authenticateWithPassword(input.email, input.password, userAgent);
    if (!authentication) {
      return applyRateLimitHeaders(Response.json({ error: "INVALID_CREDENTIALS", message: "The email or password is incorrect, or the account is temporarily unavailable." }, { status: 401 }), rateLimit);
    }

    // A correct password for an account that carries a second factor produces a
    // challenge, not a session. No cookie is set here, so there is no state in
    // which a privileged account is signed in on a password alone.
    if (authentication.outcome === "mfa") {
      const challenge = await issueMfaChallenge(authentication.userId, authentication.gate, {
        userAgent,
      });
      return applyRateLimitHeaders(Response.json({
        ok: true,
        mfa: {
          required: true,
          gate: authentication.gate,
          challengeToken: challenge.challengeToken,
          expiresAt: challenge.expiresAt.toISOString(),
        },
      }), rateLimit);
    }

    const session = authentication.session;
    (await cookies()).set(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
      maxAge: SESSION_LIFETIME_SECONDS,
      priority: "high",
    });
    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({ error: "INVALID_LOGIN", message: "Enter a valid email address and password." }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Login failed", error);
    const response = Response.json({ error: "LOGIN_FAILED", message: "Sign-in is temporarily unavailable." }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}
