import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { HonorsInstructorsWorkspace } from "@/components/honors-instructors-workspace";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveEventContext } from "@/modules/events/selection";
import { listHonorInstructors } from "@/modules/honors/instructor-repository";
import { isAccountEmailConfigured } from "@/modules/communications/account-email";

export const metadata: Metadata = {
  title: staffPageTitles.honorsInstructors,
  robots: { index: false, follow: false, nocache: true },
};

export default async function HonorInstructorsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  const back = <BackLink href={`/more/honors?event=${event.id}`} variant="staff">Back to classes</BackLink>;
  if (!permissions.includes("CONFIGURE_EVENT")) {
    return (
      <>
        {back}
        <AccessRestricted title="Instructors are restricted" detail="Event administrators choose who teaches each Honors Weekend class." />
      </>
    );
  }
  const { instructors, classes } = await listHonorInstructors(event.id);
  return (
    <>
      {back}
      <HonorsInstructorsWorkspace
        classes={classes}
        emailConfigured={isAccountEmailConfigured()}
        eventId={event.id}
        eventName={event.name}
        initialInstructors={instructors}
      />
    </>
  );
}
