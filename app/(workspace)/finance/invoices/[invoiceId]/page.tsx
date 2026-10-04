import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { InvoiceDetailView } from "@/components/invoice-detail";
import { resolveEventContext } from "@/modules/events/selection";
import { getInvoiceDetail } from "@/modules/invoices/repository";

export const metadata: Metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ invoiceId: string }>; searchParams: Promise<{ event?: string; version?: string }> }) {
  const [{ invoiceId }, { event: requested, version }] = await Promise.all([params, searchParams]);
  const { event, permissions, user } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view and prepare invoices." />;
  }
  // An invoice of another event is not found, never shown.
  const detail = await getInvoiceDetail(event.id, invoiceId, { versionId: version ?? null });
  if (!detail) notFound();
  return <InvoiceDetailView canFinalize={permissions.includes("FINALIZE_INVOICES")} detail={detail} eventId={event.id} viewerName={user.displayName} />;
}
