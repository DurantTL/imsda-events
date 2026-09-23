import { cookies } from "next/headers";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError } from "@/modules/attendee-accounts/passkey-api";
import { PASSKEY_CHALLENGE_MINUTES } from "@/modules/attendee-accounts/passkey-domain";
import { PASSKEY_SIGN_IN_COOKIE } from "@/modules/attendee-accounts/passkey-sign-in";
import { beginPasskeySignIn } from "@/modules/attendee-accounts/passkeys";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkAttendeePasskeySignInRateLimit } from "@/modules/rate-limit/service";

/** Starts a passkey sign-in (#374): a prompt for any of this site's passkeys, tied to this browser. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const rateLimit = await checkAttendeePasskeySignInRateLimit(request, "options");
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({ error: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." }, { status: 429 }), rateLimit);
    }
    const { options, challengeId } = await beginPasskeySignIn(request.headers.get("origin"));
    (await cookies()).set(PASSKEY_SIGN_IN_COOKIE, challengeId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/attendee/passkeys/sign-in",
      maxAge: PASSKEY_CHALLENGE_MINUTES * 60,
    });
    return applyRateLimitHeaders(Response.json({ options }, { headers: { "Cache-Control": "no-store" } }), rateLimit);
  } catch (error) {
    return passkeyApiError(error, "Starting passkey sign-in");
  }
}

export const POST = withRequestContext(postHandler);
