import { z } from "zod";
import { issuePasswordReset } from "@/modules/access/auth-service";
import { sendAccountRecoveryEmail } from "@/modules/communications/account-email-dispatch";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { logError } from "@/lib/logger";
import {
  applyRateLimitHeaders,
  mergeRateLimitOutcomes,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import {
  checkPasswordResetAccountRateLimit,
  checkPasswordResetClientRateLimit,
} from "@/modules/rate-limit/service";

const requestSchema = z.object({ email: z.string().trim().email().max(254) });

export async function POST(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    rateLimit = await checkPasswordResetClientRateLimit(request);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        ok: true,
        message: "If that account exists, password reset instructions are ready.",
      }), rateLimit);
    }

    const { email } = requestSchema.parse(await request.json());
    rateLimit = mergeRateLimitOutcomes(
      rateLimit,
      await checkPasswordResetAccountRateLimit(request, email)
    );
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json({
        ok: true,
        message: "If that account exists, password reset instructions are ready.",
      }), rateLimit);
    }

    // With email configured the link is emailed and never returned — the
    // response is identical whether or not the account exists. Without it, the
    // development fallback still shows the link, because otherwise there is no
    // way to obtain one at all. Production cannot reach that branch: the
    // startup contract requires the sender address and the Resend key.
    const emailed = await sendAccountRecoveryEmail(email);
    const token = emailed.configured ? null : await issuePasswordReset(email);
    const resetUrl = token && process.env.NODE_ENV !== "production"
      ? `${new URL(request.url).origin}/reset-password?token=${encodeURIComponent(token)}`
      : undefined;
    return applyRateLimitHeaders(Response.json({
      ok: true,
      message: "If that account exists, password reset instructions are ready.",
      resetUrl,
    }), rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = Response.json({ error: "INVALID_EMAIL", message: "Enter a valid email address." }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    logError("Password reset request failed", error);
    const response = Response.json({ error: "RESET_REQUEST_FAILED", message: "Password reset is temporarily unavailable." }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}
