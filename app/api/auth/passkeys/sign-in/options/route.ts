import { cookies } from "next/headers";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError } from "@/modules/access/passkey-api";
import { beginPasskeySignIn } from "@/modules/access/passkeys";
import { PASSKEY_CHALLENGE_MINUTES } from "@/modules/passkeys/domain";
import { STAFF_PASSKEY_SIGN_IN_COOKIE } from "@/modules/access/passkey-sign-in";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkStaffPasskeySignInRateLimit } from "@/modules/rate-limit/service";

/** Starts a staff passkey sign-in (#429): a prompt for any of this site's staff passkeys, tied to this browser. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const rateLimit = await checkStaffPasskeySignInRateLimit(request, "options");
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({ error: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." }, { status: 429 }), rateLimit);
    }
    const { options, challengeId } = await beginPasskeySignIn(request.headers.get("origin"));
    (await cookies()).set(STAFF_PASSKEY_SIGN_IN_COOKIE, challengeId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/auth/passkeys/sign-in",
      maxAge: PASSKEY_CHALLENGE_MINUTES * 60,
    });
    return applyRateLimitHeaders(Response.json({ options }, { headers: { "Cache-Control": "no-store" } }), rateLimit);
  } catch (error) {
    return passkeyApiError(error, "Starting passkey sign-in");
  }
}

export const POST = withRequestContext(postHandler);
