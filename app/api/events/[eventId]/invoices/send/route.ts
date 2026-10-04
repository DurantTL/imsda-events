import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { sendInvoiceVersion } from "@/modules/invoices/delivery-repository";
import { InvoiceError } from "@/modules/invoices/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Send (or resend) a finalized invoice (#168). A staff action only: MANAGE_FINANCE on the event in the URL, checked
 * here and again by the service against the version. The body names the version, which of the recipients the
 * screen showed stay ticked (keys, never addresses: the service recomputes who they are), the fingerprint of the
 * list that was shown, the subject and message, and an idempotency key so a double click or retry sends once.
 * Nothing sends an invoice automatically, ever. Same-origin only.
 */

const sendSchema = z.object({
  versionId: z.string().trim().min(1).max(64),
  recipients: z.array(z.string().trim().min(1).max(100)).max(50),
  recipientsFingerprint: z.string().trim().min(1).max(128),
  subject: z.string().max(1000),
  body: z.string().max(20000),
  idempotencyKey: z.string().trim().min(16, "The request is missing its key. Reload the page.").max(100),
  confirm: z.literal(true, { message: "Confirm that you are sending this invoice." }),
});

type RouteContext = { params: Promise<{ eventId: string }> };

function statusFor(error: InvoiceError) {
  switch (error.code) {
    case "EVENT_NOT_FOUND":
    case "INVOICE_NOT_FOUND":
    case "VERSION_NOT_FOUND":
      return 404;
    case "CONFIRMATION_REQUIRED":
    case "INVALID_INPUT":
    case "NO_RECIPIENTS":
    case "UNKNOWN_RECIPIENT":
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
    const body = sendSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await sendInvoiceVersion({
      eventId,
      versionId: body.versionId,
      actorUserId: user.id,
      selectedKeys: body.recipients,
      recipientsFingerprint: body.recipientsFingerprint,
      subject: body.subject,
      body: body.body,
      idempotencyKey: body.idempotencyKey,
      confirm: body.confirm,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_INVOICE_SEND", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof InvoiceError) return Response.json({ error: error.code, message: error.message }, { status: statusFor(error) });
    logError("Invoice send failed", error);
    return Response.json({ error: "INVOICE_SEND_FAILED", message: "The invoice could not be sent." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
