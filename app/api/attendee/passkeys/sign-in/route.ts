import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError } from "@/modules/attendee-accounts/passkey-api";
import { passkeyVerificationSchema } from "@/modules/attendee-accounts/passkey-schemas";
import { PASSKEY_SIGN_IN_COOKIE } from "@/modules/attendee-accounts/passkey-sign-in";
import { finishPasskeySignIn } from "@/modules/attendee-accounts/passkeys";
import { ATTENDEE_SESSION_COOKIE_NAME, ATTENDEE_SESSION_LIFETIME_SECONDS } from "@/modules/attendee-accounts/session-store";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkAttendeePasskeySignInRateLimit } from "@/modules/rate-limit/service";

/**
 * Signs in with a passkey (#374). The session starts with the second step
 * already passed, so a director's club opens without a separate code.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const rateLimit = await checkAttendeePasskeySignInRateLimit(request, "verify");
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({ error: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." }, { status: 429 }), rateLimit);
    }
    const cookieStore = await cookies();
    const challengeId = cookieStore.get(PASSKEY_SIGN_IN_COOKIE)?.value ?? null;
    // The prompt is single-use whatever happens next.
    cookieStore.delete({ name: PASSKEY_SIGN_IN_COOKIE, path: "/api/attendee/passkeys/sign-in" });
    const { response } = passkeyVerificationSchema.parse(await request.json());
    const result = await finishPasskeySignIn(
      challengeId,
      request.headers.get("origin"),
      response as unknown as AuthenticationResponseJSON,
      request.headers.get("user-agent"),
    );
    cookieStore.set(ATTENDEE_SESSION_COOKIE_NAME, result.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: result.session.expiresAt,
      maxAge: ATTENDEE_SESSION_LIFETIME_SECONDS,
      priority: "high",
    });
    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    return passkeyApiError(error, "Signing in with a passkey");
  }
}

export const POST = withRequestContext(postHandler);
