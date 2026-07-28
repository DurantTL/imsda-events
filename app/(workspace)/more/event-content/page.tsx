import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { EventContentWorkspace } from "@/components/event-content-workspace";
import { listEventAssets } from "@/modules/events/asset-repository";
import { listEventContentSections } from "@/modules/events/content-repository";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Event page" };

export default async function EventContentPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return (
      <AccessRestricted
        title="The event page is restricted"
        detail="Only event administrators can change what the public event page says."
      />
    );
  }
  return (
    <EventContentWorkspace
      key={event.id}
      eventId={event.id}
      eventName={event.name}
      initialSections={await listEventContentSections(event.id)}
      initialAssets={await listEventAssets(event.id)}
    />
  );
}
