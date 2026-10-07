import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { FinanceWorkspace } from "@/components/finance-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { countOpenChurchSponsorFlags } from "@/modules/promo-codes/church-sponsor-lodging";
import { listRegistrations } from "@/modules/registrations/repository";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.payments };

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ event?: string; filter?: string; registration?: string }> }) {
  const { event: requested, filter, registration } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view payment, refund, and balance details." />;
  }
  const [registrations, openChurchFlags] = await Promise.all([listRegistrations(event.id), countOpenChurchSponsorFlags(event.id)]);
  return (
    <>
    {openChurchFlags > 0 ? (
      <p role="note" className="form-error" data-testid="church-sponsor-flag-notice">
        {openChurchFlags} church-sponsored lodging {openChurchFlags === 1 ? "change was" : "changes were"} made after the church&apos;s invoice was finalized and need the finance office. <a href={`/finance/church-owed?event=${encodeURIComponent(event.id)}`}>Review them under Owed by churches</a>.
      </p>
    ) : null}
    <FinanceWorkspace
      key={event.id}
      eventId={event.id}
      initialRegistrations={registrations}
      canManage={permissions.includes("MANAGE_FINANCE")}
      initialFilter={filter}
      initialRegistrationId={registration}
    />
    </>
  );
}
