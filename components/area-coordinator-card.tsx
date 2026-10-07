import Link from "next/link";
import { ArrowRight, MapPinned } from "lucide-react";
import { NeedsAttention } from "@/components/needs-attention";
import { areaCardLinks } from "@/modules/club-reports/area-card-domain";
import { logError } from "@/lib/logger";
import { getAreaCoordinatorCard, type AreaCardEvent, type AreaCoordinatorCard } from "@/modules/club-reports/area-card-repository";

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

/** Shown while the card streams in, so the portal home never waits on it. */
export function AreaCoordinatorCardSkeleton() {
  return (
    <section className="public-manage-card account-overview-card" aria-busy="true" aria-label="Area coordinator">
      <p className="public-registration-eyebrow"><MapPinned size={15} aria-hidden="true" /> Area coordinator</p>
      <p className="field-help">Loading your events…</p>
    </section>
  );
}

/**
 * Async server component for the portal home, wrapped in `<Suspense>` by the
 * page. `account` must come from `currentAreaCoordinator()`. A failed load
 * degrades to one line instead of breaking the page.
 */
export async function AreaCoordinatorCardSection({ account }: { account: { id: string } }) {
  let card: AreaCoordinatorCard | null = null;
  try {
    card = await getAreaCoordinatorCard(account);
  } catch (error) {
    logError("Area coordinator card failed to load", error);
  }
  if (card) return <AreaCoordinatorCardView card={card} />;
  return (
    <section className="public-manage-card account-overview-card" aria-label="Area coordinator">
      <p className="public-registration-eyebrow"><MapPinned size={15} aria-hidden="true" /> Area coordinator</p>
      <p className="field-help">Summary unavailable right now.</p>
    </section>
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
      {needingAttention.either > 0 && <p><NeedsAttention label={`${needingAttention.either} ${needingAttention.either === 1 ? "club needs" : "clubs need"} attention`} /></p>}
      <p className="field-help">
        {needingAttention.either === 0
          ? `No clubs need attention for ${needingAttention.clubYear}.`
          : `${needingAttention.overdueReports} with overdue monthly reports · ${needingAttention.backgroundCheckReminders} with Sterling Volunteers reminders (${needingAttention.clubYear}).`}
      </p>
      {areaCardLinks().map((link) => (
        <Link className="secondary-button account-overview-link" href={link.href} key={link.href}>
          {link.label} <ArrowRight size={14} aria-hidden="true" />
        </Link>
      ))}
    </section>
  );
}
