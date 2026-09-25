import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { HonorsSetupWorkspace } from "@/components/honors-setup-workspace";
import { resolveEventContext } from "@/modules/events/selection";
import { getEventHonorSetup, listHonors } from "@/modules/honors/repository";

export const metadata: Metadata = { title: "Honors Weekend classes" };

export default async function HonorsSetupPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, events, permissions } = await resolveEventContext(requested);
  const back = <BackLink href={`/more?event=${event.id}`} variant="staff">Back to More</BackLink>;
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return (
      <>
        {back}
        <AccessRestricted title="Honors setup is restricted" detail="Event administrators set up the sessions and honor classes each Honors Weekend site offers." />
      </>
    );
  }
  const [setup, honors] = await Promise.all([getEventHonorSetup(event.id), listHonors()]);
  return (
    <>
      {back}
      <HonorsSetupWorkspace
        catalog={honors.filter((honor) => honor.isActive).map(({ id, code, name }) => ({ id, code, name }))}
        eventId={event.id}
        eventName={event.name}
        initialSetup={setup}
        otherEvents={events.filter((candidate) => candidate.id !== event.id).map(({ id, name }) => ({ id, name }))}
      />
    </>
  );
}
