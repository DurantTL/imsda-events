import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { PartyStatementView } from "@/components/invoice-ledger";
import { resolveEventContext } from "@/modules/events/selection";
import { getPartyStatement } from "@/modules/invoices/ledger-repository";

export const metadata: Metadata = { title: "Statement" };
export const dynamic = "force-dynamic";

/**
 * One church's statement for the event in the URL (#168). MANAGE_FINANCE on that event is required, and a church with no
 * finalized invoice on that event is not found (it never falls back to the same church's invoices on another event).
 */
export default async function StatementPage({ params, searchParams }: { params: Promise<{ partyId: string }>; searchParams: Promise<{ event?: string }> }) {
  const [{ partyId }, { event: requested }] = await Promise.all([params, searchParams]);
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view statements." />;
  }
  const statement = await getPartyStatement(event.id, partyId);
  if (!statement) notFound();
  return <PartyStatementView statement={statement} />;
}
