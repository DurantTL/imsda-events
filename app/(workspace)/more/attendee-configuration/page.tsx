import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { AttendeeConfigurationWorkspace } from "@/components/attendee-configuration-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { listAttendeeConfiguration } from "@/modules/attendee-types/repository";

export const metadata: Metadata = { title: "Attendee configuration" };

export default async function AttendeeConfigurationPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return <AccessRestricted title="Attendee configuration is restricted" detail="Event administrators can configure attendee identities and groupings." />;
  }
  const configuration = await listAttendeeConfiguration(event.id);
  const types = configuration.attendeeTypes.map((row) => ({
    id: row.id, code: row.code, label: row.label, description: row.description,
    sortOrder: row.sortOrder, isActive: row.isActive, minimumAge: row.minimumAge, maximumAge: row.maximumAge,
  }));
  const classifications = configuration.classifications.map((row) => ({
    id: row.id, kind: row.kind, code: row.code, label: row.label,
    description: row.description, sortOrder: row.sortOrder, isActive: row.isActive,
  }));
  return <AttendeeConfigurationWorkspace eventId={event.id} eventName={event.name} initialTypes={types} initialClassifications={classifications} />;
}
