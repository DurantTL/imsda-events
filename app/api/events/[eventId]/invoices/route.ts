import { z } from "zod";
import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { ensureInvoiceDocument } from "@/modules/invoices/delivery-repository";
import { findActiveMembership } from "@/modules/events/repository";
import {
  InvoiceError,
  createInvoiceDrafts,
  discardInvoiceDraft,
  finalizeInvoiceVersion,
  regenerateInvoiceDraft,
  reviseInvoice,
  addManualInvoiceLine,
  removeManualInvoiceLine,
  setEventInvoiceClubType,
  setEventInvoiceCode,
} from "@/modules/invoices/repository";
import { invoiceActionSchema } from "@/modules/invoices/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Invoice actions for a deferred-invoice event (#167): create drafts from the approved reconciliation, regenerate or
 * revise one, set the event's invoice code, and finalize a draft. MANAGE_FINANCE on the event in the URL, checked here.
 * Finalizing a draft that is an original invoice, or that changes any billable amount, also needs the Finalize
 * invoices permission: the permission is read here and the service checks it again against the amounts. The service
 * refuses any invoice or version that is not on the event in the URL. Same-origin only. Nothing here sends an invoice (#168).
 */

type RouteContext = { params: Promise<{ eventId: string }> };

function statusFor(error: InvoiceError) {
  switch (error.code) {
    case "EVENT_NOT_FOUND":
    case "INVOICE_NOT_FOUND":
    case "VERSION_NOT_FOUND":
      return 404;
    case "FINALIZE_PERMISSION_REQUIRED":
      return 403;
    case "CODE_INVALID":
    case "INVALID_INPUT":
    case "CONFIRMATION_REQUIRED":
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
    const { user, membership } = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const body = invoiceActionSchema.parse(await request.json().catch(() => ({})));
    const actorUserId = user.id;
    switch (body.action) {
      case "create-drafts":
        return Response.json(await createInvoiceDrafts({ eventId, actorUserId }));
      case "regenerate":
        return Response.json(await regenerateInvoiceDraft({ eventId, invoiceId: body.invoiceId, actorUserId }));
      case "discard":
        return Response.json(await discardInvoiceDraft({ eventId, invoiceId: body.invoiceId, actorUserId }));
      case "revise":
        return Response.json(await reviseInvoice({ eventId, invoiceId: body.invoiceId, mode: body.mode, reason: body.reason, actorUserId }));
      case "set-code":
        return Response.json(await setEventInvoiceCode({ eventId, code: body.code, actorUserId }));
      case "set-club-type":
        return Response.json(await setEventInvoiceClubType({ eventId, clubType: body.clubType, actorUserId }));
      case "add-manual-line":
        return Response.json(await addManualInvoiceLine({
          eventId,
          invoiceId: body.invoiceId,
          line: { item: body.item, description: body.description ?? null, quantity: body.quantity, rateCents: body.rate },
          actorUserId,
          canFinalizeInvoices: effectivePermissions(user, membership).includes("FINALIZE_INVOICES"),
        }));
      case "remove-manual-line":
        return Response.json(await removeManualInvoiceLine({
          eventId,
          invoiceId: body.invoiceId,
          lineId: body.lineId,
          actorUserId,
          canFinalizeInvoices: effectivePermissions(user, membership).includes("FINALIZE_INVOICES"),
        }));
      case "finalize": {
        const finalized = await finalizeInvoiceVersion({
          eventId,
          versionId: body.versionId,
          actorUserId,
          idempotencyKey: body.idempotencyKey,
          confirm: body.confirm,
          canFinalizeInvoices: effectivePermissions(user, membership).includes("FINALIZE_INVOICES"),
        });
        // Make and store the PDF right after the finalization commits (#168). Best effort: finalization has already
        // succeeded, and a failure here only means the PDF is made on first view or send, as before. Nothing is sent.
        try {
          await ensureInvoiceDocument(eventId, finalized.versionId);
        } catch (pdfError) {
          logError("The invoice PDF could not be made at finalization; it will be made on first use.", pdfError);
        }
        return Response.json(finalized);
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_INVOICE_REQUEST", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof InvoiceError) {
      return Response.json({ error: error.code, message: error.message, blockers: error.blockers }, { status: statusFor(error) });
    }
    logError("Invoice request failed", error);
    return Response.json({ error: "INVOICE_REQUEST_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
