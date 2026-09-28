import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubOrderWorkspace } from "@/components/club-order-workspace";
import { loadOrderWorkspace } from "@/modules/club-orders/repository";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { syncHonorOrderNeeds } from "@/modules/honors/order-source";

export const metadata: Metadata = { title: "Honor orders" };
export const dynamic = "force-dynamic";

/**
 * A club's honor order screen (#487). Opens on the roster's own gate, like
 * Supplies: a director or deputy orders and hands out, a registrar views.
 */
export default async function ClubOrdersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  // An editor's visit records new completions as needs (ones on file are
  // skipped); a registrar's view-only visit reads what's on file and never writes.
  if (access.capabilities.manageTeam) await syncHonorOrderNeeds(organizationId);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <ClubOrderWorkspace
        initial={await loadOrderWorkspace(organizationId)}
        organizationId={organizationId}
        readOnly={!access.capabilities.manageTeam}
      />
    </>
  );
}
