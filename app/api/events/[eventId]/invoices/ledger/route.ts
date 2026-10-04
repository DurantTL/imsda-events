import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { correctArPosting, postInvoiceToAr, recordInvoicePayment, setInvoicePaymentInstructions, voidInvoicePayment } from "@/modules/invoices/ledger-repository";
import { InvoiceError } from "@/modules/invoices/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Accounts receivable, manual payments and the payment instruction for a deferred-invoice event (#168). Every action
 * needs MANAGE_FINANCE on the event in the URL (checked here) and the service refuses any version, invoice or
 * payment that is not on that event. Entries are append-only: an AR posting is corrected by a new posting, a
 * payment is voided by a reversal with a reason. Same-origin only.
 */

const id = z.string().trim().min(1).max(64);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("post-to-ar"), versionId: id, postedOn: z.string().max(20), reference: z.string().max(500).nullable().optional() }),
  z.object({ action: z.literal("correct-ar"), versionId: id, postedOn: z.string().max(20), reference: z.string().max(500).nullable().optional(), reason: z.string().max(2000) }),
  z.object({ action: z.literal("record-payment"), invoiceId: id, amount: z.string().max(40), checkNumber: z.string().max(500).nullable().optional(), receivedOn: z.string().max(20), note: z.string().max(5000).nullable().optional(), requestKey: z.string().max(200) }),
  z.object({ action: z.literal("void-payment"), paymentId: id, reason: z.string().max(2000), requestKey: z.string().max(200) }),
  z.object({ action: z.literal("set-payment-instructions"), instructions: z.string().max(5000).nullable() }),
]);

type RouteContext = { params: Promise<{ eventId: string }> };

function statusFor(error: InvoiceError) {
  switch (error.code) {
    case "EVENT_NOT_FOUND":
    case "INVOICE_NOT_FOUND":
    case "VERSION_NOT_FOUND":
    case "PAYMENT_NOT_FOUND":
      return 404;
    case "INVALID_INPUT":
      return 400;
    default:
      return 409;
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const { user } = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const actorUserId = user.id;
    switch (body.action) {
      case "post-to-ar":
        return Response.json(await postInvoiceToAr({ eventId, versionId: body.versionId, postedOn: body.postedOn, reference: body.reference ?? null, actorUserId }));
      case "correct-ar":
        return Response.json(await correctArPosting({ eventId, versionId: body.versionId, postedOn: body.postedOn, reference: body.reference ?? null, reason: body.reason, actorUserId }));
      case "record-payment":
        return Response.json(await recordInvoicePayment({ eventId, invoiceId: body.invoiceId, amount: body.amount, checkNumber: body.checkNumber ?? null, receivedOn: body.receivedOn, note: body.note ?? null, requestKey: body.requestKey, actorUserId }));
      case "void-payment":
        return Response.json(await voidInvoicePayment({ eventId, paymentId: body.paymentId, reason: body.reason, requestKey: body.requestKey, actorUserId }));
      case "set-payment-instructions":
        return Response.json(await setInvoicePaymentInstructions({ eventId, instructions: body.instructions, actorUserId }));
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_INVOICE_REQUEST", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof InvoiceError) return Response.json({ error: error.code, message: error.message }, { status: statusFor(error) });
    logError("Invoice ledger request failed", error);
    return Response.json({ error: "INVOICE_REQUEST_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
