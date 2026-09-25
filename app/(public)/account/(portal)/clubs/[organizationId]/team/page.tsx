import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubTeamWorkspace } from "@/components/club-team-workspace";
import { listPendingClubTeamInvites } from "@/modules/club-imports/invites";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { listClubTeam } from "@/modules/organizations/director-grants-repository";

export const metadata: Metadata = { title: "Club admins" };
export const dynamic = "force-dynamic";

/** Directors and deputies give and remove the Registrar and Reporter roles (#375), and manage pending invites (#425). */
export default async function ClubTeamPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  const back = <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>;
  if (!access.capabilities.manageTeam) {
    return (
      <>
        {back}
        <p className="public-manage-empty">Only the club&apos;s director or deputy can change the team.</p>
      </>
    );
  }
  const [team, invites] = await Promise.all([
    listClubTeam(organizationId),
    listPendingClubTeamInvites(organizationId),
  ]);
  return (
    <>
      {back}
      <ClubTeamWorkspace
        initialTeam={team}
        initialInvites={invites}
        organizationId={organizationId}
        viewerAccountId={access.accountId}
      />
    </>
  );
}
