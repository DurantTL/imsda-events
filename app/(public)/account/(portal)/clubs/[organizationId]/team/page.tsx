import type { Metadata } from "next";
import { ClubTeamWorkspace } from "@/components/club-team-workspace";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { listClubTeam } from "@/modules/organizations/director-grants-repository";

export const metadata: Metadata = { title: "Club team" };
export const dynamic = "force-dynamic";

/** Directors and deputies give and remove the Registrar and Reporter roles (#375). */
export default async function ClubTeamPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  if (!access.capabilities.manageTeam) {
    return <p className="public-manage-empty">Only the club&apos;s director or deputy can change the team.</p>;
  }
  const team = await listClubTeam(organizationId);
  return <ClubTeamWorkspace initialTeam={team} organizationId={organizationId} viewerAccountId={access.accountId} />;
}
