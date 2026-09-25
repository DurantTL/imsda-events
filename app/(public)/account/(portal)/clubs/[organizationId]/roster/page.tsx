import type { Metadata } from "next";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { clubPortalComplianceStatuses } from "@/modules/background-checks/repository";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";

export const metadata: Metadata = { title: "Club roster" };
export const dynamic = "force-dynamic";

export default async function ClubRosterPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  const clubYear = clubYearFor(new Date());
  // Status only, never the note, and only for a director or deputy: this is the club's own page (#427).
  const [members, complianceStatuses] = await Promise.all([
    listRoster(organizationId, clubYear),
    clubPortalComplianceStatuses(organizationId, clubYear, access.capabilities),
  ]);
  return (
    <ClubRosterWorkspace
      canSeeBirthDates={access.capabilities.seeBirthDates}
      clubYear={clubYear}
      complianceStatuses={complianceStatuses}
      initialMembers={members}
      organizationId={organizationId}
    />
  );
}
