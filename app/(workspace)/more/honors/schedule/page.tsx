import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { HonorsScheduleBoard } from "@/components/honors-schedule-board";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveEventContext } from "@/modules/events/selection";
import { getScheduleBoard } from "@/modules/honors/schedule-repository";

export const metadata: Metadata = {
  title: staffPageTitles.honorsSchedule,
  robots: { index: false, follow: false, nocache: true },
};

export default async function HonorsSchedulePage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  const back = <BackLink href={`/more/honors?event=${event.id}`} variant="staff">Back to Honors Weekend classes</BackLink>;
  // The same permission as the class setup: moving a class changes the event's configuration.
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return (
      <>
        {back}
        <AccessRestricted title="The schedule board is restricted" detail="Event administrators arrange the Honors Weekend classes into rooms and sessions." />
      </>
    );
  }
  return (
    <>
      {back}
      <HonorsScheduleBoard eventId={event.id} initialBoard={await getScheduleBoard(event.id)} />
    </>
  );
}
