import Link from "next/link";
import { ArrowRight, CalendarDays } from "lucide-react";
import type { ClubEventSummary } from "@/modules/club-registrations/repository";

function formatDate(value: string, timeZone: string) {
  return new Date(value).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

function statusFor(event: ClubEventSummary) {
  if (event.registration) return { tone: "green", label: `Registered · ${event.registration.attendeeCount} going` };
  if (!event.available) return { tone: "gold", label: "Not open for clubs yet" };
  if (event.phase === "UPCOMING") return { tone: "purple", label: "Registration opens soon" };
  if (event.phase === "CLOSED") return { tone: "coral", label: "Registration closed" };
  if (event.draft) return { tone: "purple", label: `Draft saved · ${event.draft.selectedCount} chosen` };
  return { tone: "purple", label: "Open" };
}

/** Club events this club can register for, with where it stands on each. */
export function ClubEventList({ events, organizationId }: { events: ClubEventSummary[]; organizationId: string }) {
  const primaryEventId = events.find((event) => !event.registration && event.available && event.phase === "OPEN")?.id;
  return (
    <section className="public-manage-card" aria-labelledby="club-events-heading">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Register your club</p>
        <h2 id="club-events-heading">Club events</h2>
      </div>
      {events.length === 0 ? (
        <p className="public-manage-empty">
          <CalendarDays size={17} aria-hidden="true" /> No club events yet. Club events billed to your church appear here once the conference publishes registration. If you expected one, contact the conference office.
        </p>
      ) : (
        <ul className="public-manage-club-list">
          {events.map((event) => {
            const status = statusFor(event);
            // One filled primary per screen (#743): only the first event still open for
            // registration gets the filled button; the rest are outlined.
            const isPrimaryEvent = event.id === primaryEventId;
            return (
              <li key={event.id}>
                <CalendarDays size={17} aria-hidden="true" />
                <span>
                  <strong>{event.name}</strong>
                  <small>
                    {formatDate(event.startsAt, event.timezone)}
                    {event.registeredLocation ? ` · ${event.registeredLocation.name}` : event.location ? ` · ${event.location}` : ""}
                    {event.hasLocations && !event.registeredLocation && !event.registration ? " · Choose a location when you register" : ""}
                  </small>
                  <span className={`status-chip ${status.tone}`}>{status.label}</span>
                </span>
                {(event.registration || (event.available && event.phase === "OPEN")) && (
                  <Link className={isPrimaryEvent ? "primary-button club-event-action" : "secondary-button club-event-action"} href={`/account/clubs/${organizationId}/events/${event.id}`}>
                    {event.registration ? "View" : event.draft ? "Continue" : "Register"} <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
