import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileText, UsersRound } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { listRegisteredClubs, resolveClubOversight } from "@/modules/club-rosters/event-oversight";

export const metadata: Metadata = { title: "Clubs" };
export const dynamic = "force-dynamic";

/** Every club registered for this Pathfinder event, for its event managers (#387). */
export default async function EventClubsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, allowed, clubEvent } = await resolveClubOversight(requested);
  if (!allowed) {
    return (
      <AccessRestricted
        title="Club oversight is restricted"
        detail={clubEvent
          ? "Event administrators of this Pathfinder event can view its clubs."
          : "Club oversight is for Pathfinder events that clubs register for."}
      />
    );
  }
  const clubs = await listRegisteredClubs(event.id);
  return (
    <section className="page-stack">
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href={`/more?event=${event.id}`}>Back to More</Link>
        <Link className="secondary-button" href={`/more/clubs/reports?event=${event.id}`}>
          <FileText aria-hidden="true" size={14} /> All clubs&apos; monthly reports
        </Link>
      </div>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Event manager · view only</p>
          <h2>Clubs at {event.name}</h2>
          <p>Every club registered for this event. Open one to see its roster (ages, not birth dates), admins, and reports. Nothing can be changed here.</p>
        </div>
      </div>
      <section className="panel">
        {clubs.length === 0 ? (
          <p className="quiet-copy"><UsersRound aria-hidden="true" size={15} /> No clubs have registered yet.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Registered clubs</caption>
              <thead><tr><th scope="col">Club</th><th scope="col">Going</th><th scope="col">Registration</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {clubs.map((club) => (
                  <tr key={club.organizationId}>
                    <th scope="row" translate="no">{club.name}{club.sponsoringChurch && <small> · {club.sponsoringChurch}</small>}</th>
                    <td>{club.attendeeCount}</td>
                    <td>{club.confirmationCode}</td>
                    <td><Link className="secondary-button" href={`/more/clubs/${club.organizationId}?event=${event.id}`}>Open <ArrowRight aria-hidden="true" size={13} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
