import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { RosterExportBuilder } from "@/components/roster-export-builder";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { listRosterExportFormats } from "@/modules/club-rosters/export-repository";

export const metadata: Metadata = { title: "Roster export builder" };
export const dynamic = "force-dynamic";

export default async function ClubRosterExportPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const formats = await listRosterExportFormats(organizationId);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}/roster`}>Back to {access.club.name}&apos;s roster</BackLink>
      <RosterExportBuilder
        canSeeBirthDates={access.capabilities.seeBirthDates}
        initialFormats={formats}
        organizationId={organizationId}
      />
    </>
  );
}
