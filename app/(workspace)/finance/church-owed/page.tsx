import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { ChurchAmountsOwed } from "@/components/church-amounts-owed";
import { resolveEventContext } from "@/modules/events/selection";
import { listChurchSponsoredPromoLines } from "@/modules/promo-codes/church-sponsored-repository";
import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";

export const metadata: Metadata = { title: "Owed by churches" };

export default async function ChurchOwedPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return <AccessRestricted title="Finance is restricted" detail="Only event administrators and finance managers can view what each church owes." />;
  }
  const [owed, sponsoredLines] = await Promise.all([
    listChurchAmountsOwed(event.id),
    listChurchSponsoredPromoLines(event.id),
  ]);
  return (
    <ChurchAmountsOwed
      eventId={event.id}
      isDeferredOrganizationBilling={event.billingMode === "DEFERRED_ORGANIZATION_INVOICE"}
      rows={owed}
      sponsoredLines={sponsoredLines}
    />
  );
}
