import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { FinanceReportPanel } from "@/components/invoice-ledger";
import { Invoices } from "@/components/invoices";
import { resolveEventContext } from "@/modules/events/selection";
import { getInvoiceFinanceReport } from "@/modules/invoices/ledger-repository";
import { getInvoicesView } from "@/modules/invoices/repository";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view and prepare invoices." />;
  }
  const view = await getInvoicesView(event.id);
  // The finance report section and payment instruction (#168): deferred receivables, apart from attendee payments.
  const report = view.isDeferred ? await getInvoiceFinanceReport(event.id) : null;
  return (
    <>
      <Invoices canFinalize={permissions.includes("FINALIZE_INVOICES")} eventId={event.id} view={view} />
      {report && (
        <section className="page-stack">
          <FinanceReportPanel eventId={event.id} paymentInstructions={report.paymentInstructions} report={report} />
        </section>
      )}
    </>
  );
}
