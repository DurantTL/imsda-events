import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubMeetingNotes } from "@/components/club-meeting-notes";
import { listClubMeetingNotes } from "@/modules/club-meeting-notes/repository";
import { getClubRoleAccess } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Meeting notes" };
export const dynamic = "force-dynamic";

/** One simple note per club meeting (#426): counts and honors worked on, so the monthly report can pull from them. */
export default async function ClubMeetingNotesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getClubRoleAccess(organizationId);
  if (access.state !== "OK") return null;
  const back = <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>;
  if (!access.capabilities.submitReports) {
    return (
      <>
        {back}
        <p className="public-manage-empty">Meeting notes are kept by the club&apos;s director, deputy, or reporter.</p>
      </>
    );
  }
  const notes = await listClubMeetingNotes(organizationId);
  return (
    <>
      {back}
      <ClubMeetingNotes initialNotes={notes} organizationId={organizationId} />
    </>
  );
}
