import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { CheckInWorkspace } from "@/components/check-in-workspace";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";
import { backgroundFlaggedAttendeeIds } from "@/modules/background-checks/repository";

export const metadata: Metadata = {
  title: "Check-in",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function CheckInPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_CHECK_IN")) {
    return <AccessRestricted title="Check-in is restricted" detail="Only event administrators and check-in staff can view the arrival roster and record attendance." />;
  }
  const [registrations, flagged] = await Promise.all([
    listRegistrations(event.id, { statuses: activeRegistrationStatuses }),
    backgroundFlaggedAttendeeIds(event.id),
  ]);
  return <CheckInWorkspace key={event.id} eventName={event.name} eventId={event.id} initialRegistrations={registrations} canCheckIn={permissions.includes("MANAGE_CHECK_IN")} showBalances={event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE"} backgroundFlaggedAttendeeIds={[...flagged]} />;
}
