import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { TeamResultsWorkspace } from "@/components/team-results-workspace";
import { staffPageTitles } from "@/components/staff-navigation";
import { listTeamResults } from "@/modules/club-teams/results-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";

export const metadata: Metadata = { title: staffPageTitles.teamResults };
export const dynamic = "force-dynamic";

/**
 * Team results (#809): staff with report access (or an event administrator of this club event) read them; staff who manage
 * the event's registrations (MANAGE_REGISTRATION) also enter them.
 */
export default async function TeamResultsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, allowed, permissions } = await resolveClubReportsAccess(requested);
  if (!allowed) {
    return <AccessRestricted title="Team results are restricted" detail="Ask an event administrator for report access to this club event." />;
  }
  const rows = await listTeamResults(event.id);
  return (
    <>
      <BackLink href={`/more?event=${event.id}`} variant="staff">Back to More</BackLink>
      <TeamResultsWorkspace canEdit={permissions.includes("MANAGE_REGISTRATION")} eventId={event.id} initialRows={rows} key={event.id} />
    </>
  );
}
