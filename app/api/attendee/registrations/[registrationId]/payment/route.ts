import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { authorizeAttendeeRegistration } from "@/modules/attendee-accounts/registrations-repository";
import { squarePaymentInputSchema } from "@/modules/payments/square-domain";
import {
  createAttendeeSquarePayment,
  getAttendeeSquareCheckout,
  SquarePaymentOperationError,
} from "@/modules/payments/square-repository";
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

async function access(context: Context) {
  const { account, via } = await getCurrentAttendee();
  if (!account || via !== "attendee") return null;
  const { registrationId } = await context.params;
  return authorizeAttendeeRegistration(account.verifiedEmail, registrationId);
}

function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    return json(
      { message: error.issues[0]?.message ?? "The payment request is invalid." },
      { status: 400 },
    );
  }
  if (error instanceof SquarePaymentOperationError) {
    return json(
      { error: error.code, message: error.message, retryable: error.retryable },
      {
        status: error.code === "SQUARE_NOT_CONFIGURED"
          ? 503
          : error.code === "PAYMENT_RESULT_UNCERTAIN"
            || error.code === "PAYMENT_OPERATION_CONFLICT"
            ? 503
            : 422,
      },
    );
  }
  throw error;
}

async function getHandler(_request: Request, context: Context) {
  const authorized = await access(context);
  if (!authorized) {
    return json({ message: "This registration is unavailable." }, { status: 404 });
  }
  const checkout = await getAttendeeSquareCheckout(authorized);
  return checkout
    ? json({ checkout })
    : json({ message: "This registration is unavailable." }, { status: 404 });
}

async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const authorized = await access(context);
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
    const input = squarePaymentInputSchema.parse(await request.json());
    return applyRateLimitHeaders(json({
      payment: await createAttendeeSquarePayment(authorized, input),
    }), rateLimit);
  } catch (error) {
    return applyRateLimitHeaders(failure(error), rateLimit);
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
