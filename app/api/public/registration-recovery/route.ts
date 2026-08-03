import { after } from "next/server";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import {
  establishRegistrationAccess,
  requestRegistrationAccessRecovery,
} from "@/modules/public-access/repository";
import {
  applyRateLimitHeaders,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import {
  checkRegistrationCodeAccessRateLimit,
  checkRegistrationRecoveryRateLimit,
} from "@/modules/rate-limit/service";

const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("access"),
    clientRequestId: z.uuid(),
    confirmationCode: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(160),
  }),
  z.strictObject({
    action: z.literal("email"),
    clientRequestId: z.uuid(),
    email: z.string().trim().email().max(160),
  }),
]);

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

const SAME_ANSWER = {
  ok: true as const,
  message: "If those details match an active registration, a new private link is on its way.",
};

function json(
  body: unknown,
  init?: ResponseInit,
  rateLimit?: RateLimitOutcome,
) {
  const response = Response.json(body, {
    ...init,
    headers: { ...privateHeaders, ...init?.headers },
  });
  return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const input = requestSchema.parse(await request.json());
    rateLimit = input.action === "access"
      ? await checkRegistrationCodeAccessRateLimit(request, input)
      : await checkRegistrationRecoveryRateLimit(request, input.email);
    if (!rateLimit.allowed) {
      return json({
        error: "RATE_LIMITED",
        message: "Too many recovery requests for those details. Try again later.",
      }, { status: 429 }, rateLimit);
    }

    if (input.action === "access") {
      const access = await establishRegistrationAccess(input);
      if (!access) {
        return json({
          error: "REGISTRATION_ACCESS_UNAVAILABLE",
          message: "We could not open a registration with those details. Check both fields or request a private link by email.",
        }, { status: 401 }, rateLimit);
      }
      return json({
        ok: true,
        managePath: access.managePath,
        expiresAt: access.expiresAt.toISOString(),
      }, undefined, rateLimit);
    }

    const recovery = await requestRegistrationAccessRecovery(input);
    if (recovery.pendingMessageIds.length > 0) {
      after(async () => {
        try {
          await processQueuedMessageIdsAfterCommit(recovery.pendingMessageIds);
        } catch (error) {
          logError("Registration recovery email processing failed after the response.", error);
        }
      });
    }
    return json(SAME_ANSWER, undefined, rateLimit);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return json({
        error: "INVALID_RECOVERY_REQUEST",
        message: "Enter a valid registration contact email and, for direct access, a confirmation code.",
      }, { status: 400 }, rateLimit);
    }
    logError("Registration access recovery request failed.", error);
    return json({
      error: "RECOVERY_UNAVAILABLE",
      message: "Registration link recovery is temporarily unavailable.",
    }, { status: 500 }, rateLimit);
  }
}

export const POST = withRequestContext(postHandler);
