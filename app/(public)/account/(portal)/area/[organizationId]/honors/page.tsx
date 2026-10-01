import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
      <ClubHonorsWorkspace
        clubYear={clubYear}
        honorOptions={honors}
        initialRows={rows}
        organizationId={organizationId}
        readOnly
      />
    </>
  );
}
