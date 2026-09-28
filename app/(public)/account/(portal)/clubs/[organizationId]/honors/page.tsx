import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubHonorsWorkspace } from "@/components/club-honors-workspace";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listActiveHonorOptions, listClubHonorsPage } from "@/modules/honors/member-honor-repository";

export const metadata: Metadata = { title: "Club honors" };
export const dynamic = "force-dynamic";

/**
 * A club's own Honors page (#486): the same roster roles that can edit the
 * roster (director, deputy, registrar) can record and edit honors here.
 */
export default async function ClubHonorsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const clubYear = clubYearFor(new Date());
  const [rows, honors] = await Promise.all([
    listClubHonorsPage(organizationId, clubYear),
    listActiveHonorOptions(),
  ]);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <ClubHonorsWorkspace
        clubYear={clubYear}
        honorOptions={honors}
        initialRows={rows}
        organizationId={organizationId}
      />
    </>
  );
}
