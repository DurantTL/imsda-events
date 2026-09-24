import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { PeopleWorkspace } from "@/components/people-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";
import { backgroundFlaggedAttendeeIds } from "@/modules/background-checks/repository";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ event?: string; filter?: string; registration?: string }> }) {
  const { event: requested, filter, registration } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("VIEW_SENSITIVE_DATA")) {
    return <AccessRestricted title="People records are restricted" detail="Your event role does not include access to attendee names, contact details, or registration records." />;
  }
  const [registrations, flagged] = await Promise.all([listRegistrations(event.id), backgroundFlaggedAttendeeIds(event.id)]);
  return <PeopleWorkspace key={event.id} eventId={event.id} eventSlug={event.slug} eventTimezone={event.timezone} waitlistEnabled={event.waitlistEnabled} initialRegistrations={registrations} canEdit={permissions.includes("MANAGE_REGISTRATION")} canEmail={permissions.includes("MANAGE_COMMUNICATIONS")} initialFilter={filter} initialRegistrationId={registration} backgroundFlaggedAttendeeIds={[...flagged]} />;
}
