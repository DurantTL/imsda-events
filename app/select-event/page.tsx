import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, ChevronRight } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { SignOutButton } from "@/components/sign-out-button";
import { getCurrentSession } from "@/modules/access/current-session";
import { listEventsForUser } from "@/modules/events/repository";

export const metadata: Metadata = { title: "Choose an event" };

function formatEventDates(start: Date, end: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone });
  return formatter.formatRange(start, end);
}

/**
 * A minimal event picker for a staff account with several active event
 * memberships and no usable remembered event (#108 queue 1). Lives outside
 * `(workspace)`, whose layout would otherwise pick an event for them before
 * this page ever renders.
 */
export default async function SelectEventPage() {
  const session = await getCurrentSession();
  if (!session.user) redirect("/login");
  if (session.user.globalRole === "SYSTEM_ADMIN") redirect("/admin");

  const events = await listEventsForUser(session.user.id, false);
  if (events.length === 0) redirect("/no-access");
  if (events.length === 1) redirect(`/overview?event=${encodeURIComponent(events[0].id)}`);

  return (
    <main className="auth-page">
      <section className="auth-card select-event-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Staff workspace</p>
          <h1>Choose an event</h1>
          <p>{session.user.email} has access to more than one event. Pick one to continue.</p>
        </div>
        <ul className="select-event-list">
          {events.map((event) => (
            <li key={event.id}>
              <Link className="select-event-option" href={`/overview?event=${encodeURIComponent(event.id)}`}>
                <span>
                  <strong>{event.name}</strong>
                  <small><CalendarDays aria-hidden="true" size={13} /> {formatEventDates(event.startsAt, event.endsAt, event.timezone)}</small>
                </span>
                <ChevronRight aria-hidden="true" size={17} />
              </Link>
            </li>
          ))}
        </ul>
        <SignOutButton className="secondary-button full-button" />
      </section>
    </main>
  );
}
