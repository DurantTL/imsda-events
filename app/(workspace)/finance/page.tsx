import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { FinanceWorkspace } from "@/components/finance-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";

export const metadata: Metadata = { title: "Finance" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ event?: string; filter?: string; registration?: string }> }) {
  const { event: requested, filter, registration } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view payment, refund, and balance details." />;
  }
  const registrations = await listRegistrations(event.id);
  return (
    <FinanceWorkspace
      key={event.id}
      eventId={event.id}
      initialRegistrations={registrations}
      canManage={permissions.includes("MANAGE_FINANCE")}
      initialFilter={filter}
      initialRegistrationId={registration}
    />
  );
}
