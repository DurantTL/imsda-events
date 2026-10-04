import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { StatementsList } from "@/components/invoice-ledger";
import { resolveEventContext } from "@/modules/events/selection";
import { listEventStatements } from "@/modules/invoices/ledger-repository";

export const metadata: Metadata = { title: "Statements" };
export const dynamic = "force-dynamic";

/**
 * Statements for the event (#168): one row per church with a finalized invoice on THIS event. MANAGE_FINANCE on the
 * event in the URL decides who sees it, and only that event's invoices are listed, so a finance manager of one event
 * never sees another event's invoices.
 */
export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view statements." />;
  }
  const statements = await listEventStatements(event.id);
  return <StatementsList eventId={event.id} eventName={statements.eventName} parties={statements.parties} totals={statements.totals} />;
}
