import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { ChurchAmountsOwed } from "@/components/church-amounts-owed";
import { LocationFilter } from "@/components/location-filter";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { resolveEventContext } from "@/modules/events/selection";
import { listChurchSponsoredPromoLines } from "@/modules/promo-codes/church-sponsored-repository";
import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";

export const metadata: Metadata = { title: "Owed by churches" };

export default async function ChurchOwedPage({ searchParams }: { searchParams: Promise<{ event?: string; location?: string }> }) {
  const { event: requested, location: requestedLocation } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view what each church owes." />;
  }
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const [owed, sponsoredLines] = await Promise.all([
    listChurchAmountsOwed(event.id, { locationId }),
    listChurchSponsoredPromoLines(event.id),
  ]);
  return (
    <>
      <LocationFilter basePath="/finance/church-owed" locations={locations} params={{ event: event.id }} selectedId={locationId} />
      <ChurchAmountsOwed
        eventId={event.id}
        isDeferredOrganizationBilling={event.billingMode === "DEFERRED_ORGANIZATION_INVOICE"}
        locationId={locationId}
        rows={owed}
        sponsoredLines={sponsoredLines}
      />
    </>
  );
}
