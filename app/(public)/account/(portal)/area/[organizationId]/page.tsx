import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClubGuardiansPanel } from "@/components/club-guardians-panel";
import { ClubOverview } from "@/components/club-overview";
import { getPrisma } from "@/lib/prisma";
import { resolveAreaGuardianViewer } from "@/modules/club-rosters/guardians-access";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * Any club, view only, for an Area Coordinator (#387). Ages only, no birth
 * dates. The hero, menu and "View only" notice come from the layout (#722).
 * Guardian contacts (#510) are shown for every club: coordinators need them
 * during events.
 */
export default async function AreaClubPage({ params }: { params: Promise<{ organizationId: string }> }) {
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, isActive: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();

  const guardianViewer = await resolveAreaGuardianViewer();

  return (
    <>
    <ClubOverview
      portalView
      complianceCounts
      honorsHref={`/account/area/${organizationId}/honors`}
      organizationId={organizationId}
      reportHref={(month) => `/account/area/${organizationId}/reports/${month}`}
      reportsEditable={false}
    />
    {guardianViewer && <ClubGuardiansPanel organizationId={organizationId} viewer={guardianViewer} />}
    </>
  );
}
