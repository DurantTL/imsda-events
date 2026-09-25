import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubEventList } from "@/components/club-event-list";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { listClubEvents } from "@/modules/club-registrations/repository";

export const metadata: Metadata = { title: "Club events" };
export const dynamic = "force-dynamic";

export default async function ClubEventsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  const events = await listClubEvents(organizationId);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <ClubEventList events={events} organizationId={organizationId} />
    </>
  );
}
