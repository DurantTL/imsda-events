import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { AttendanceReconciliation } from "@/components/attendance-reconciliation";
import { LocationFilter } from "@/components/location-filter";
import { getAttendanceReconciliationView } from "@/modules/attendance-reconciliation/repository";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Attendance reconciliation" };

export default async function AttendanceReconciliationPage({ searchParams }: { searchParams: Promise<{ event?: string; location?: string; version?: string }> }) {
  const { event: requested, location: requestedLocation, version } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can review who attended and what each church is billed for." />;
  }
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const view = await getAttendanceReconciliationView(event.id, { locationId, versionId: version ?? null });
  return (
    <>
      <LocationFilter basePath="/finance/attendance-reconciliation" locations={locations} params={{ event: event.id, ...(version ? { version } : {}) }} selectedId={locationId} />
      <AttendanceReconciliation eventId={event.id} locationId={locationId} view={view} />
    </>
  );
}
