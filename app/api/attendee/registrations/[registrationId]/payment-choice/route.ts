import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { authorizeAttendeeRegistration } from "@/modules/attendee-accounts/registrations-repository";
import { paymentChoiceInputSchema } from "@/modules/payments/payment-choice-domain";
import {
  chooseAttendeePromotedWaitlistPayment,
  PaymentChoiceOperationError,
} from "@/modules/payments/payment-choice-repository";
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

async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const { account, via } = await getCurrentAttendee();
  if (!account || via !== "attendee") {
    return json({ message: "This registration is unavailable." }, { status: 404 });
  }
  const { registrationId } = await context.params;
  const access = await authorizeAttendeeRegistration(
    account.verifiedEmail,
    registrationId,
  );
  if (!access) {
    return json({ message: "This registration is unavailable." }, { status: 404 });
  }
  try {
    const input = paymentChoiceInputSchema.parse(await request.json());
    return json({
      paymentChoice: await chooseAttendeePromotedWaitlistPayment(access, input),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json(
        { message: error.issues[0]?.message ?? "The payment choice is invalid." },
        { status: 400 },
      );
    }
    if (error instanceof PaymentChoiceOperationError) {
      return json(
        { error: error.code, message: error.message, retryable: error.retryable },
        { status: 422 },
      );
    }
    throw error;
  }
}

export const POST = withRequestContext(postHandler);
