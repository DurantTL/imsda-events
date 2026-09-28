import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { ClubHonorsWorkspace } from "@/components/club-honors-workspace";
import { getPrisma } from "@/lib/prisma";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listActiveHonorOptions, listClubHonorsPage } from "@/modules/honors/member-honor-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club honors", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/** Any club's honors, view only, for an Area Coordinator (#387, #486). */
export default async function AreaClubHonorsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();
  const clubYear = clubYearFor(new Date());
  const [rows, honors] = await Promise.all([
    listClubHonorsPage(organizationId, clubYear),
    listActiveHonorOptions(),
  ]);
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
        <p className="inline-notice" role="status">
          <Eye aria-hidden="true" size={14} /> View only. The club records and changes its own honors.
        </p>
        <ClubHonorsWorkspace
          clubYear={clubYear}
          honorOptions={honors}
          initialRows={rows}
          organizationId={organizationId}
          readOnly
        />
      </div>
    </>
  );
}
