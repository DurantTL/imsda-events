import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { CopyFromPastEvent } from "@/components/copy-from-past-event";
import { getCurrentSession } from "@/modules/access/current-session";
import { listEventsForUser } from "@/modules/events/repository";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";

export const metadata: Metadata = { title: "Copy from a past event", robots: { index: false, follow: false } };

export default async function CopyFromPastEventPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  // Newest first: the year you are most likely to copy is the last one.
  const events = (await listEventsForUser(user.id, true)).slice().reverse();
  const sources = events.map((event) => ({
    id: event.id,
    name: event.name,
    startsOn: calendarDateInEventTimeZone(event.startsAt, event.timezone),
    endsOn: calendarDateInEventTimeZone(event.endsAt, event.timezone),
    isPublished: event.isPublished,
  }));

  return (
    <main className="event-setup-page">
      <header className="event-setup-header">
        <div className="brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div>
        <div><p className="eyebrow">System administration</p><h1>Copy from a past event</h1></div>
      </header>
      <CopyFromPastEvent sources={sources} />
    </main>
  );
}
