import type { Metadata } from "next";
import Link from "next/link";
import { AccessRestricted } from "@/components/access-restricted";
import { PromoCodeWorkspace } from "@/components/promo-code-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { eventBillsSponsoredPromoCodes } from "@/modules/promo-codes/church-sponsored";
import { listPromoCodes, listSponsorChurchOptions } from "@/modules/promo-codes/repository";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.promoCodes };

export default async function PromoCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return (
      <AccessRestricted
        title="Promo codes are restricted"
        detail="Ask an event administrator for finance access before creating or changing registration discounts."
      />
    );
  }
  const canSponsorByChurch = eventBillsSponsoredPromoCodes(event);
  const [promoCodes, sponsorChurches] = await Promise.all([
    listPromoCodes(event.id),
    canSponsorByChurch ? listSponsorChurchOptions() : Promise.resolve([]),
  ]);
  return (
    <>
      <Link className="secondary-button more-back-link" href={`/more?event=${encodeURIComponent(event.id)}`}>
        Back to More
      </Link>
      <PromoCodeWorkspace
        eventId={event.id}
        initialPromoCodes={promoCodes}
        canSponsorByChurch={canSponsorByChurch}
        sponsorChurches={sponsorChurches}
      />
    </>
  );
}

