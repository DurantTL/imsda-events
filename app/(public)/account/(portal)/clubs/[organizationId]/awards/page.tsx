import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubEarnedAwardsWorkspace } from "@/components/club-earned-awards-workspace";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { loadEarnedAwardsWorkspace } from "@/modules/earned-awards/order-source";

export const metadata: Metadata = { title: "Earned awards" };
export const dynamic = "force-dynamic";

/**
 * A club's earned awards (#532): class insignia, event patches, Good Conduct
 * and TLT items, and Master Award progress. Opens on the roster's own gate,
 * like Orders: a director or deputy confirms and records, a registrar views.
 */
export default async function ClubAwardsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <ClubEarnedAwardsWorkspace
        initial={await loadEarnedAwardsWorkspace(organizationId, { forEditing: access.capabilities.manageTeam })}
        ordersHref={`/account/clubs/${organizationId}/orders`}
        organizationId={organizationId}
        readOnly={!access.capabilities.manageTeam}
      />
    </>
  );
}
