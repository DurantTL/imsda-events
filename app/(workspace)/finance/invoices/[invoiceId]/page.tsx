import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { ChurchSponsorFlags } from "@/components/church-sponsor-flags";
import { InvoiceDetailView } from "@/components/invoice-detail";
import { resolveEventContext } from "@/modules/events/selection";
import { getInvoiceDeliveryHistory } from "@/modules/invoices/delivery-repository";
import { loadEventLedger } from "@/modules/invoices/ledger-repository";
import { getInvoiceDetail } from "@/modules/invoices/repository";
import { listOpenChurchSponsorFlags } from "@/modules/promo-codes/church-sponsor-lodging";

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
  // Delivery, AR and payments (#168), scoped to this event like everything above.
  const [ledger] = await loadEventLedger(event.id, { invoiceId });
  const deliveries = ledger ? await getInvoiceDeliveryHistory(event.id, invoiceId) : [];
  // Lodging changes that moved a church's share after this invoice was finalized (#813): never applied, flagged here too.
  const versionIds = new Set(detail.versions.map((version) => version.id));
  const flags = (await listOpenChurchSponsorFlags(event.id)).filter((flag) => flag.invoiceVersionId !== null && versionIds.has(flag.invoiceVersionId));
  return <>
    <ChurchSponsorFlags eventId={event.id} flags={flags} />
    <InvoiceDetailView canFinalize={permissions.includes("FINALIZE_INVOICES")} deliveries={deliveries} detail={detail} eventId={event.id} ledger={ledger ?? null} viewerName={user.displayName} />
  </>;
}
