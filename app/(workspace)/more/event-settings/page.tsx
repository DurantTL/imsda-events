import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { getEventSettings } from "@/modules/events/repository";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Event settings" };

export default async function EventSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return <AccessRestricted title="Event settings are restricted" detail="Only event administrators can change public details, capacity, registration dates, waitlist behavior, and publishing." />;
  }
  const settings = await getEventSettings(event.id);
  if (!settings) notFound();
  return <EventSettingsWorkspace key={event.id} mode="edit" initialEvent={settings} />;
}
