import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { ProgramAssignmentsWorkspace } from "@/components/program-assignments-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { canManageProgramAssignments } from "@/modules/program-assignments/access";
import { getProgramAssignmentWorkspace } from "@/modules/program-assignments/repository";

export const metadata: Metadata = { title: "Seminar assignments" };

export default async function ProgramAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  if (!canManageProgramAssignments(permissions)) {
    return (
      <AccessRestricted
        title="Program assignments are restricted"
        detail="Ask an event administrator for registration or form-management access before creating seminar rosters."
      />
    );
  }
  const workspace = await getProgramAssignmentWorkspace(event.id);
  return (
    <ProgramAssignmentsWorkspace
      eventId={event.id}
      eventName={event.name}
      fields={workspace.fields}
      diagnostics={workspace.diagnostics}
      initialRuns={workspace.runs}
    />
  );
}
