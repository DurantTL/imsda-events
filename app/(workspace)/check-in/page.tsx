import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { CheckInWorkspace } from "@/components/check-in-workspace";
import { LocationFilter } from "@/components/location-filter";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { getCurrentSession } from "@/modules/access/current-session";
import { findDefaultCheckInEventId } from "@/modules/checkin/default-event";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";
import { backgroundFlaggedAttendeeIds } from "@/modules/background-checks/repository";
import { listClubCheckInInfo } from "@/modules/club-registrations/repository";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = {
  title: staffPageTitles.checkIn,
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function CheckInPage({ searchParams }: { searchParams: Promise<{ event?: string; location?: string }> }) {
  const { event: requested, location: requestedLocation } = await searchParams;
  // #470: a signed-out visitor goes to staff sign-in and comes straight back
  // here (the login page validates `next` as a same-site path).
  const { user } = await getCurrentSession();
  if (!user) {
    redirect(requested
      ? `/login?next=${encodeURIComponent(`/check-in?event=${encodeURIComponent(requested)}`)}`
      : "/login?next=/check-in");
  }
  // #470: a bare /check-in opens an event this account can check people in
  // at, rather than whichever event happens to sort first.
  if (!requested) {
    const defaultEventId = await findDefaultCheckInEventId(user);
    if (defaultEventId) redirect(`/check-in?event=${encodeURIComponent(defaultEventId)}`);
  }
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_CHECK_IN")) {
    return <AccessRestricted title="Staff access required" detail="Check-in is for event administrators and check-in staff. Your account doesn't have check-in access for this event. If you're helping at arrival, ask the event administrator to add check-in access to your account." />;
  }
  // A check-in desk can work one location, or all of them at once (#413).
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const [registrations, flagged, clubs] = await Promise.all([
    listRegistrations(event.id, { statuses: activeRegistrationStatuses, locationId }),
    backgroundFlaggedAttendeeIds(event.id),
    listClubCheckInInfo(event.id, { locationId }),
  ]);
  return <>
    <LocationFilter basePath="/check-in" locations={locations} params={{ event: event.id }} selectedId={locationId} />
    <CheckInWorkspace key={event.id} eventName={event.name} eventId={event.id} initialRegistrations={registrations} canCheckIn={permissions.includes("MANAGE_CHECK_IN")} showBalances={event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE"} backgroundFlaggedAttendeeIds={[...flagged]} clubs={clubs} />
  </>;
}
