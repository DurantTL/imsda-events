import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { markRosterUnlocked } from "@/modules/club-rosters/access";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkAttendeeRosterUnlockRateLimit } from "@/modules/rate-limit/service";
import {
  AttendeeMfaError,
  beginAttendeeMfaEnrollment,
  confirmAttendeeMfaEnrollment,
  disableAttendeeMfa,
  getAttendeeMfaStatus,
  regenerateAttendeeRecoveryCodes,
} from "@/modules/attendee-accounts/mfa-service";

const code = z.string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().min(1).max(32));

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({ action: z.literal("confirm"), code }),
  // A current code is optional: a session that passed its second step
  // recently needs none, any other session must present one.
  z.object({ action: z.literal("regenerate-recovery-codes"), code: code.optional() }),
  z.object({ action: z.literal("disable"), code }),
]);

function failure(error: unknown) {
  if (error instanceof AttendeeMfaError) {
    const status = error.code === "MFA_LOCKED" ? 429
      : error.code === "RECENT_VERIFICATION_REQUIRED" ? 403
      : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: "That request could not be completed." },
      { status: 400 },
    );
  }
  logError("Attendee MFA request failed", error);
  return Response.json(
    { error: "MFA_REQUEST_FAILED", message: "Two-factor settings are temporarily unavailable." },
    { status: 500 },
  );
}

async function accountId() {
  return (await getCurrentAttendee()).account?.id ?? null;
}

/** Setting up an authenticator proves a code, so this sign-in has passed its second step. */
async function markThisSessionVerified() {
  const { via, sessionId } = await getCurrentAttendee();
  if (via === "attendee" && sessionId) await markRosterUnlocked(sessionId);
}

async function getHandler() {
  const id = await accountId();
  return id
    ? Response.json(await getAttendeeMfaStatus(id))
    : Response.json({ error: "SIGN_IN_REQUIRED", message: "Sign in first." }, { status: 401 });
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const id = await accountId();
  if (!id) {
    return Response.json({ error: "SIGN_IN_REQUIRED", message: "Sign in first." }, { status: 401 });
  }
  try {
    const input = actionSchema.parse(await request.json());
    if (input.action === "begin") {
      return Response.json(await beginAttendeeMfaEnrollment(id));
    }
    if (input.action === "confirm") {
      const confirmed = await confirmAttendeeMfaEnrollment(id, input.code);
      await markThisSessionVerified();
      return Response.json({ ...confirmed, status: await getAttendeeMfaStatus(id) });
    }
    if (input.action === "regenerate-recovery-codes") {
      // Only the person's own attendee session can mint codes; a staff member
      // viewing their linked attendee account has no attendee session here.
      const { via, sessionId } = await getCurrentAttendee();
      const proof = { sessionId: via === "attendee" ? sessionId : null, code: input.code ?? null };
      if (!proof.code) return Response.json(await regenerateAttendeeRecoveryCodes(id, proof));
      // A code here is a second-factor guess like the roster unlock, so it
      // spends from the same budget (5 per account, 20 per client, per 15
      // minutes) — checked before anything is verified.
      const rateLimit = await checkAttendeeRosterUnlockRateLimit(request, id);
      if (!rateLimit.allowed) {
        return applyRateLimitHeaders(Response.json({
          error: "RATE_LIMITED",
          message: "Too many attempts. Wait a few minutes and try again.",
        }, { status: 429 }), rateLimit);
      }
      return applyRateLimitHeaders(
        Response.json(await regenerateAttendeeRecoveryCodes(id, proof)),
        rateLimit,
      );
    }
    await disableAttendeeMfa(id, input.code);
    return Response.json({ ok: true, status: await getAttendeeMfaStatus(id) });
  } catch (error) {
    return failure(error);
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
