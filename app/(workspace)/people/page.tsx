import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { LocationFilter } from "@/components/location-filter";
import { PeopleWorkspace } from "@/components/people-workspace";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";
import { backgroundFlaggedAttendeeIds } from "@/modules/background-checks/repository";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ event?: string; filter?: string; registration?: string; location?: string }> }) {
  const { event: requested, filter, registration, location: requestedLocation } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("VIEW_SENSITIVE_DATA")) {
    return <AccessRestricted title="People records are restricted" detail="Your event role does not include access to attendee names, contact details, or registration records." />;
  }
  // Each location on its own, or all combined (#413).
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const [registrations, flagged] = await Promise.all([listRegistrations(event.id, { locationId }), backgroundFlaggedAttendeeIds(event.id)]);
  return <>
    <LocationFilter basePath="/people" locations={locations} params={{ event: event.id, filter }} selectedId={locationId} />
    <PeopleWorkspace key={event.id} eventId={event.id} eventSlug={event.slug} eventTimezone={event.timezone} waitlistEnabled={event.waitlistEnabled} initialRegistrations={registrations} canEdit={permissions.includes("MANAGE_REGISTRATION")} canEmail={permissions.includes("MANAGE_COMMUNICATIONS")} initialFilter={filter} initialRegistrationId={registration} backgroundFlaggedAttendeeIds={[...flagged]} locationId={locationId} />
  </>;
}
