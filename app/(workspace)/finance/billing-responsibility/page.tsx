import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BillingResponsibility } from "@/components/billing-responsibility";
import { LocationFilter } from "@/components/location-filter";
import { getBillingResponsibilityView } from "@/modules/billing-responsibility/repository";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Billing responsibility" };

export default async function BillingResponsibilityPage({ searchParams }: { searchParams: Promise<{ event?: string; location?: string }> }) {
  const { event: requested, location: requestedLocation } = await searchParams;
  const { event, permissions, user } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view who each registration is billed to." />;
  }
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const view = await getBillingResponsibilityView(event.id, { locationId });
  return (
    <>
      <LocationFilter basePath="/finance/billing-responsibility" locations={locations} params={{ event: event.id }} selectedId={locationId} />
      <BillingResponsibility eventId={event.id} isSystemAdministrator={user.globalRole === "SYSTEM_ADMIN"} locationId={locationId} view={view} />
    </>
  );
}
