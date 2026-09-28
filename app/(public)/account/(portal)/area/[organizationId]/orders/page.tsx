import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubOrderWorkspace } from "@/components/club-order-workspace";
import { getPrisma } from "@/lib/prisma";
import { loadOrderWorkspace } from "@/modules/club-orders/repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Honor orders", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/** Any club's honor orders, view only, for an Area Coordinator (#387, #487). Reads what's on file; never writes. */
export default async function AreaClubOrdersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();
  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1 translate="no">{club.name}</h1>
        </div>
      </section>
      <div className="account-page-body club-roster-stack">
        <BackLink href={`/account/area/${organizationId}`}>Back to {club.name}</BackLink>
        <ClubOrderWorkspace initial={await loadOrderWorkspace(organizationId)} organizationId={organizationId} readOnly />
      </div>
    </>
  );
}
