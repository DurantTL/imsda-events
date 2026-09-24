import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { ClubAssignmentsWorkspace } from "@/components/club-assignments-workspace";
import {
  canManageClubAssignments,
  canSendClubAssignmentMessages,
} from "@/modules/club-registrations/assignments-access";
import { listClubAssignments } from "@/modules/club-registrations/assignments-repository";
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
  if (!canManageClubAssignments(permissions)) {
    return (
      <AccessRestricted
        title="Club assignments are restricted"
        detail="Ask an event administrator for registration-management access before assigning campsites, duties, or activities."
      />
    );
  }
  const assignments = await listClubAssignments(event.id);
  return (
    <ClubAssignmentsWorkspace
      eventId={event.id}
      eventName={event.name}
      initialAssignments={assignments}
      canSend={canSendClubAssignmentMessages(permissions)}
    />
  );
}
