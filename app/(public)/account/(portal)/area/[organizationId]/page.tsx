import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { ClubOverview } from "@/components/club-overview";
import { getPrisma } from "@/lib/prisma";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/** Any club, view only, for an Area Coordinator (#387). Ages only, no birth dates. */
export default async function AreaClubPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const coordinator = await currentAreaCoordinator();
  if (!coordinator) notFound();
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true, parentOrganization: { select: { name: true } } },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1 translate="no">{club.name}</h1>
          {club.parentOrganization && <p translate="no">{club.parentOrganization.name}</p>}
        </div>
      </section>
      <div className="account-page-body club-roster-stack">
        <BackLink href="/account/clubs">All clubs</BackLink>
        <p className="inline-notice" role="status">
          <Eye aria-hidden="true" size={14} /> View only. You see what the club&apos;s director sees, with ages instead of
          birth dates. The club makes changes.
        </p>
        <ClubOverview
          organizationId={organizationId}
          reportHref={(month) => `/account/area/${organizationId}/reports/${month}`}
          reportsEditable={false}
        />
      </div>
    </>
  );
}
