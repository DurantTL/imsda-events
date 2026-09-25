import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { ClubAssignmentsWorkspace } from "@/components/club-assignments-workspace";
import {
  canManageClubAssignments,
  canSendClubAssignmentMessages,
} from "@/modules/club-registrations/assignments-access";
import { listClubAssignments } from "@/modules/club-registrations/assignments-repository";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Club assignments" };
export const dynamic = "force-dynamic";

/** Staff screen for campsite/duty/activity assignments per club (#410). */
export default async function ClubAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  const back = <BackLink href={`/more?event=${event.id}`} variant="staff">Back to More</BackLink>;
  if (!canManageClubAssignments(permissions)) {
    return (
      <>
        {back}
        <AccessRestricted
          title="Club assignments are restricted"
          detail="Ask an event administrator for registration-management access before assigning campsites, duties, or activities."
        />
      </>
    );
  }
  // Only club (church-billed) events have club registrations to assign.
  const { clubEvent } = await resolveClubOversight(event.id);
  if (!clubEvent) {
    return (
      <>
        {back}
        <AccessRestricted
          title="Club assignments are for club events"
          detail="This event doesn't take club registrations. Choose a club event to assign campsites, duties, and activities."
        />
      </>
    );
  }
  const assignments = await listClubAssignments(event.id);
  return (
    <>
      {back}
      <ClubAssignmentsWorkspace
        eventId={event.id}
        eventName={event.name}
        initialAssignments={assignments}
        canSend={canSendClubAssignmentMessages(permissions)}
      />
    </>
  );
}
