import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { getInvoicePdfForDownload } from "@/modules/invoices/delivery-repository";
import { InvoiceError } from "@/modules/invoices/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * The PDF of a finalized invoice version (#168), for staff. MANAGE_FINANCE on the event in the URL; a version of
 * another event is a 404. The bytes are the stored document, verified against its recorded hash, never regenerated.
 * Never public: there is no unauthenticated way to this file, and the response is not cacheable.
 */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string; versionId: string }> }) {
  try {
    const { eventId, versionId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const pdf = await getInvoicePdfForDownload(eventId, versionId);
    return new Response(Buffer.from(pdf.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Invoice-Sha256": pdf.sha256,
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof InvoiceError) {
      const status = error.code === "VERSION_NOT_FOUND" || error.code === "EVENT_NOT_FOUND" || error.code === "NOT_FINALIZED" ? 404 : 409;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    logError("Unable to download an invoice PDF", error);
    return Response.json({ error: "INVOICE_PDF_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
