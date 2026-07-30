import type { Metadata } from "next";
import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { CommunityModerationWorkspace } from "@/components/community-moderation-workspace";
import { getStaffCommunity } from "@/modules/community/repository";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Attendee community" };

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_COMMUNICATIONS")) {
    return (
      <AccessRestricted
        title="Community moderation is restricted"
        detail="Only event administrators and communications managers can enable or moderate attendee discussion."
      />
    );
  }
  const community = await getStaffCommunity(event.id);
  if (!community) {
    return <AccessRestricted title="Event unavailable" detail="The selected event could not be loaded." />;
  }
  return (
    <section className="page-stack community-workspace">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Attendee experience</p>
          <h2>Community moderation</h2>
          <p>Open, pause, and moderate the private discussion for {event.name}.</p>
        </div>
        <div className="intro-actions">
          <Link className="secondary-button" href={`/communications?event=${encodeURIComponent(event.id)}`}>Messages</Link>
          <Link className="primary-button" href={`/account/events/${encodeURIComponent(event.slug)}?preview=staff`}>
            <MessagesSquare size={16} aria-hidden="true" /> Attendee preview
          </Link>
        </div>
      </div>
      <CommunityModerationWorkspace community={community} />
    </section>
  );
}
