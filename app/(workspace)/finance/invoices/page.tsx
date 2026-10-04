import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { Invoices } from "@/components/invoices";
import { resolveEventContext } from "@/modules/events/selection";
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
  return <Invoices canFinalize={permissions.includes("FINALIZE_INVOICES")} eventId={event.id} view={view} />;
}
