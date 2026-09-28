import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { verifyAttendeeSecondFactor } from "@/modules/attendee-accounts/mfa-service";
import { accountHasSecondStepAccess } from "@/modules/attendee-accounts/sign-in-gate";
import { markRosterUnlocked } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { rosterUnlockSchema } from "@/modules/club-rosters/schemas";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkAttendeeRosterUnlockRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

/**
 * Every account the second sign-in step applies to — club directors,
 * deputies, registrars, reporters, and Area Coordinators (#387) — enters
 * their authenticator code once per session here to clear it. Whether a
 * club role includes the roster itself (`clubCapabilities`) is a separate,
 * later question; this route only unlocks the session.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, via, sessionId } = await getCurrentAttendee();
    if (!account || via !== "attendee" || !sessionId) {
      return Response.json(
        { error: "OWN_SESSION_REQUIRED", message: "Sign in with your own attendee account to open the roster." },
        { status: 401 },
      );
    }
    // Never "directs a club" alone (#464): an Area Coordinator directs none,
    // but still has a second step to clear. No branch here reveals whether a
    // roster exists — an account with no gated access at all gets the same
    // 404 either way.
    if (!(await accountHasSecondStepAccess(account.id))) {
      return Response.json({ error: "NOT_FOUND", message: "No club roster is available to this account." }, { status: 404 });
    }
    const rateLimit = await checkAttendeeRosterUnlockRateLimit(request, account.id);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        error: "RATE_LIMITED",
        message: "Too many attempts. Wait a few minutes and try again.",
      }, { status: 429 }), rateLimit);
    }
    const { code } = rosterUnlockSchema.parse(await request.json());
    await verifyAttendeeSecondFactor(account.id, code);
    await markRosterUnlocked(sessionId);
    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    return rosterApiError(error, "Opening the roster");
  }
}

export const POST = withRequestContext(postHandler);
