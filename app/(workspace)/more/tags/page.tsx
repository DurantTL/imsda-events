import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { TagConfigurationWorkspace } from "@/components/tag-configuration-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { listTags } from "@/modules/tags/repository";

export const metadata: Metadata = { title: "Tags" };

export default async function TagConfigurationPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return <AccessRestricted title="Tag configuration is restricted" detail="Event administrators can configure the tag vocabulary staff apply to registrations and attendees." />;
  }
  const tags = await listTags(event.id);
  return <TagConfigurationWorkspace eventId={event.id} eventName={event.name} initialTags={tags} />;
}
