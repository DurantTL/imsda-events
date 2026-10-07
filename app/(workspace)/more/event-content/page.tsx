import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { EventContentWorkspace } from "@/components/event-content-workspace";
import { listEventAssets } from "@/modules/events/asset-repository";
import { sanitizedHtmlBySection } from "@/modules/events/content-html";
import { listEventContentSections } from "@/modules/events/content-repository";
import { resolveEventContext } from "@/modules/events/selection";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.eventContent };

export default async function EventContentPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event: requested } = await searchParams;
  const { event, permissions, user } = await resolveEventContext(requested);
  const back = <BackLink href={`/more?event=${event.id}`} variant="staff">Back to More</BackLink>;
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return (
      <>
        {back}
        <AccessRestricted
          title="The event page is restricted"
          detail="Only event administrators can change what the public event page says."
        />
      </>
    );
  }
  const sections = await listEventContentSections(event.id);
  return (
    <>
      {back}
      <EventContentWorkspace
        key={event.id}
        eventId={event.id}
        eventName={event.name}
        eventSlug={event.slug}
        eventTiming={{
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
          timezone: event.timezone,
        }}
        isSystemAdmin={user.globalRole === "SYSTEM_ADMIN"}
        initialSections={sections}
        initialSanitizedHtml={sanitizedHtmlBySection(sections)}
        initialAssets={await listEventAssets(event.id)}
      />
    </>
  );
}
