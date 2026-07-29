import { after } from "next/server";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  deliverQueuedAttendeeEmail,
  queueAttendeeEditVerificationEmail,
} from "@/modules/attendee-accounts/attendee-email-dispatch";
import { mintAttendeeCodeWithoutSending } from "@/modules/attendee-accounts/attendee-email";
import {
  beginAttendeeEditStepUp,
  bindAttendeeStepUpMessage,
} from "@/modules/attendee-accounts/step-up-service";
import { checkAttendeeEditStepUpRateLimit } from "@/modules/rate-limit/service";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account || via !== "attendee" || !sessionId) {
    return Response.json(
      { error: "SIGN_IN_REQUIRED", message: "Sign in to request an edit code." },
      { status: 401 },
    );
  }
  const rateLimit = await checkAttendeeEditStepUpRateLimit(request, account.id);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(Response.json({
      error: "RATE_LIMITED",
      message: "Too many edit-code requests. Try again later.",
    }, { status: 429 }), rateLimit);
  }
  const pending = await beginAttendeeEditStepUp(account.id, sessionId);
  const dispatch = await queueAttendeeEditVerificationEmail({
    accountId: account.id,
    stepUpCodeId: pending.id,
    email: account.verifiedEmail,
    displayName: account.displayName,
  });
  if (dispatch.messageId) after(() => deliverQueuedAttendeeEmail(dispatch.messageId!));

  const developmentMessageId = `development:edit-verification:${pending.id}`;
  if (!dispatch.configured) {
    await bindAttendeeStepUpMessage(pending.id, developmentMessageId);
  }
  const developmentCode = !dispatch.configured && process.env.NODE_ENV !== "production"
    ? await mintAttendeeCodeWithoutSending({
        accountId: account.id,
        purpose: "edit-verification",
        messageId: developmentMessageId,
      })
    : null;
  return applyRateLimitHeaders(Response.json({
    ok: true,
    message: "Check your email for a six-digit edit code.",
    developmentCode: developmentCode ?? undefined,
  }), rateLimit);
}

export const POST = withRequestContext(postHandler);
