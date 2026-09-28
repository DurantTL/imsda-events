import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { EventPatchesWorkspace } from "@/components/event-patches-workspace";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { listEventAwardItems } from "@/modules/earned-awards/event-items";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Event patches" };

/** Links catalog patches and pins to a club event (#532): event configuration, so CONFIGURE_EVENT. */
export default async function EventPatchesPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  const back = <BackLink href={`/more?event=${event.id}`} variant="staff">Back to More</BackLink>;
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return (
      <>
        {back}
        <AccessRestricted title="Event patches are restricted" detail="Event administrators link the patch or pin a club event gives its attendees." />
      </>
    );
  }
  // Only club events have club attendees to suggest a patch to.
  const { clubEvent } = await resolveClubOversight(event.id);
  if (!clubEvent) {
    return (
      <>
        {back}
        <AccessRestricted title="Event patches are for club events" detail="This event doesn't take club registrations. Choose a club event to link its patch or pin." />
      </>
    );
  }
  return (
    <>
      {back}
      <EventPatchesWorkspace eventId={event.id} eventName={event.name} initial={await listEventAwardItems(event.id)} />
    </>
  );
}
