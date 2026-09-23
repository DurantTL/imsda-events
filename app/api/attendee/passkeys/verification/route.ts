import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnAttendeeSession } from "@/modules/attendee-accounts/passkey-api";
import { passkeyVerificationSchema } from "@/modules/attendee-accounts/passkey-schemas";
import { finishPasskeyVerification } from "@/modules/attendee-accounts/passkeys";
import { markRosterUnlocked } from "@/modules/club-rosters/access";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkAttendeeRosterUnlockRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

/** A passkey answers the second step for this session, exactly as an authenticator code does. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnAttendeeSession();
    const rateLimit = await checkAttendeeRosterUnlockRateLimit(request, account.id);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many attempts. Wait a few minutes and try again.",
      }, { status: 429 }), rateLimit);
    }
    const { response } = passkeyVerificationSchema.parse(await request.json());
    await finishPasskeyVerification(account, sessionId, request.headers.get("origin"), response as unknown as AuthenticationResponseJSON);
    await markRosterUnlocked(sessionId);
    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    return passkeyApiError(error, "Checking a passkey");
  }
}

export const POST = withRequestContext(postHandler);
