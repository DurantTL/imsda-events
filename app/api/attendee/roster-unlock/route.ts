import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { verifyAttendeeSecondFactor } from "@/modules/attendee-accounts/mfa-service";
import { markRosterUnlocked } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { rosterUnlockSchema } from "@/modules/club-rosters/schemas";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkAttendeeRosterUnlockRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

/** A director enters their authenticator code once per session to open club rosters. */
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
    if ((await listDirectedClubs(account.id)).length === 0) {
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
