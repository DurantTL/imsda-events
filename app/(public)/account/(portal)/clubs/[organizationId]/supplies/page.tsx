import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubSupplyStockWorkspace } from "@/components/club-supply-stock-workspace";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { listClubStock } from "@/modules/club-supplies/repository";

export const metadata: Metadata = { title: "Club supplies" };
export const dynamic = "force-dynamic";

/**
 * A club's supplies on hand (#531). Opens on the roster's own gate, so the
 * layout shows the authenticator prompt until the roster is unlocked; a
 * director or deputy edits, a registrar views.
 */
export default async function ClubSuppliesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <ClubSupplyStockWorkspace
        initialStock={await listClubStock(organizationId)}
        organizationId={organizationId}
        readOnly={!access.capabilities.manageTeam}
      />
    </>
  );
}
