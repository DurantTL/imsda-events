import Link from "next/link";
import { ArrowRight, MapPinned } from "lucide-react";
import { areaCardLinks } from "@/modules/club-reports/area-card-domain";
import type { AreaCardEvent, AreaCoordinatorCard } from "@/modules/club-reports/area-card-repository";

const dayFormat = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(iso));

function EventList({ events, empty }: { events: AreaCardEvent[]; empty: string }) {
  if (events.length === 0) return <p className="field-help">{empty}</p>;
  return (
    <ul className="account-overview-list">
      {events.map((event) => (
        <li key={`${event.eventId}:${event.locationName ?? ""}`}>
          <span>
            <strong translate="no">{event.eventName}{event.locationName ? ` · ${event.locationName}` : ""}</strong>
            <small>
              {dayFormat(event.startsAt, event.timezone)} to {dayFormat(event.endsAt, event.timezone)} · {event.registration.label}
              {" · "}{event.clubsRegistered} {event.clubsRegistered === 1 ? "club" : "clubs"}, {event.headcount} {event.headcount === 1 ? "person" : "people"}
            </small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The Area Coordinator card on the portal home (#656): view only, counts only. */
export function AreaCoordinatorCardView({ card }: { card: AreaCoordinatorCard }) {
  const { needingAttention } = card;
  return (
    <section className="public-manage-card account-overview-card" aria-label="Area coordinator">
      <p className="public-registration-eyebrow"><MapPinned size={15} aria-hidden="true" /> Area coordinator</p>
      <h2>Your locations</h2>
      <EventList events={card.coordinatedLocations} empty="You aren't set as the coordinator of an upcoming event location." />
      <h2>Upcoming club events</h2>
      <EventList events={card.clubEvents} empty="No upcoming club events." />
      <h2>Clubs needing attention</h2>
      <p className="field-help">
        {needingAttention.either === 0
          ? `No clubs need attention for ${needingAttention.clubYear}.`
          : `${needingAttention.overdueReports} with overdue monthly reports · ${needingAttention.backgroundCheckReminders} with background-check reminders (${needingAttention.clubYear}).`}
      </p>
      {areaCardLinks().map((link) => (
        <Link className="secondary-button account-overview-link" href={link.href} key={link.href}>
          {link.label} <ArrowRight size={14} aria-hidden="true" />
        </Link>
      ))}
    </section>
  );
}
