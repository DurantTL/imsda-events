import type { Metadata } from "next";
import Link from "next/link";
import { AccessRestricted } from "@/components/access-restricted";
import { LodgingAssignmentsWorkspace } from "@/components/lodging-assignments-workspace";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveEventContext } from "@/modules/events/selection";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { LodgingError } from "@/modules/lodging/errors";

export const metadata: Metadata = { title: staffPageTitles.lodgingAssignments };

export default async function LodgingAssignmentsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  // Decided here on the server, and again by every API route the screen calls.
  if (!permissions.includes("MANAGE_REGISTRATION")) {
    return <AccessRestricted title="Lodging assignments are restricted" detail="Staff who manage registrations can place guests in rooms and sites." />;
  }
  const view = await getAssignmentWorkspace(event.id, { canSeeSensitive: permissions.includes("VIEW_SENSITIVE_DATA") }).catch((error: unknown) => {
    if (error instanceof LodgingError && error.code === "NO_PROPERTY") return null;
    throw error;
  });
  if (!view) {
    return (
      <section className="panel">
        <h2>{staffPageTitles.lodgingAssignments}</h2>
        <p>This event has no lodging property yet. An event administrator chooses one on the <Link href={`/more/lodging?event=${encodeURIComponent(event.id)}`}>Lodging page</Link> first.</p>
      </section>
    );
  }
  return (
    <LodgingAssignmentsWorkspace
      eventName={event.name}
      initialView={view}
      canConfigure={permissions.includes("CONFIGURE_EVENT")}
      canExport={permissions.includes("VIEW_REPORTS")}
    />
  );
}
