import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeSecondStepPending } from "@/modules/attendee-accounts/portal-second-step";
import { authorizeAttendeeRegistration } from "@/modules/attendee-accounts/registrations-repository";
import { squarePaymentLinkInputSchema } from "@/modules/payments/square-domain";
import { createAttendeeSquarePaymentLink } from "@/modules/payments/square-hosted-repository";
import { SquarePaymentOperationError } from "@/modules/payments/square-repository";
import { checkPublicPaymentRateLimit } from "@/modules/rate-limit/service";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ registrationId: string }> };
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...privateHeaders, ...init?.headers },
  });
}

function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    return json(
      { message: error.issues[0]?.message ?? "The payment link request is invalid." },
      { status: 400 },
    );
  }
  if (error instanceof SquarePaymentOperationError) {
    return json(
      { error: error.code, message: error.message, retryable: error.retryable },
      {
        status: error.code === "SQUARE_NOT_CONFIGURED"
          || error.code === "PAYMENT_RESULT_UNCERTAIN"
          || error.code === "PAYMENT_OPERATION_CONFLICT"
          ? 503
          : error.code === "PAYMENT_ATTEMPT_FAILED"
            ? 422
            : 409,
      },
    );
  }
  throw error;
}

async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const { account, via } = await getCurrentAttendee();
  if (!account || via !== "attendee") {
    return json({ message: "This registration is unavailable." }, { status: 404 });
  }
  // Same role-dependent second step the portal enforces (#744).
  if (await attendeeSecondStepPending()) {
    return json(
      { code: "SECOND_STEP_REQUIRED", message: "Finish two-step sign-in to manage payment." },
      { status: 403 },
    );
  }
  const { registrationId } = await context.params;
  const authorized = await authorizeAttendeeRegistration(account.verifiedEmail, registrationId);
  if (!authorized) {
    return json({ message: "This registration is unavailable." }, { status: 404 });
  }
  const rateLimit = await checkPublicPaymentRateLimit(
    request,
    `account:${authorized.registrationId}`,
  );
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      json({ message: "Too many payment attempts. Try again later." }, { status: 429 }),
      rateLimit,
    );
  }
  try {
    const input = squarePaymentLinkInputSchema.parse(await request.json());
    return applyRateLimitHeaders(json({
      link: await createAttendeeSquarePaymentLink(authorized, input),
    }), rateLimit);
  } catch (error) {
    return applyRateLimitHeaders(failure(error), rateLimit);
  }
}

export const POST = withRequestContext(postHandler);
