import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { PaymentOperationError, recordRefund } from "@/modules/payments/repository";
import { refundInputSchema } from "@/modules/payments/schemas";

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string; paymentId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, paymentId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const input = refundInputSchema.parse(await request.json());
    const registration = await recordRefund(eventId, paymentId, access.user.id, input);
    return Response.json({ registration }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_REFUND", issues: error.issues }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof PaymentOperationError) {
      const status = error.code === "REFUND_EXCEEDS_AVAILABLE"
        ? 400
        : error.code === "CARD_REFUND_REQUIRES_SQUARE"
          ? 409
          : 404;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    console.error("Unable to record refund", error);
    return Response.json({ error: "REFUND_CREATE_FAILED" }, { status: 500 });
  }
}
