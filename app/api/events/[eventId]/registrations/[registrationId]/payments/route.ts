import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { PaymentOperationError, recordManualPayment } from "@/modules/payments/repository";
import { manualPaymentSchema } from "@/modules/payments/schemas";

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string; registrationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const input = manualPaymentSchema.parse(await request.json());
    const registration = await recordManualPayment(eventId, registrationId, access.user.id, input);
    return Response.json({ registration }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_PAYMENT", issues: error.issues }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof PaymentOperationError) {
      const status = error.code === "PAYMENT_EXCEEDS_BALANCE"
        ? 400
        : error.code === "REGISTRATION_NOT_PAYABLE"
          ? 409
          : 404;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    console.error("Unable to record manual payment", error);
    return Response.json({ error: "PAYMENT_CREATE_FAILED" }, { status: 500 });
  }
}
