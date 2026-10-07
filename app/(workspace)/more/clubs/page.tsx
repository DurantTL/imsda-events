import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileText, UsersRound } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { BackgroundCheckBadge } from "@/components/background-check-flags";
import { listEventBackgroundFlags } from "@/modules/background-checks/repository";
import { getTeamSettings } from "@/modules/club-teams/settings-repository";
import { listRegisteredClubs, resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { staffPageTitles } from "@/components/staff-navigation";
import { cardCell } from "@/components/table-card-labels";

export const metadata: Metadata = { title: staffPageTitles.clubs };
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
  const [clubs, backgroundFlags, teamSettings] = await Promise.all([listRegisteredClubs(event.id), listEventBackgroundFlags(event.id), getTeamSettings(event.id)]);
  const neededByClub = new Map<string, number>();
  for (const person of backgroundFlags?.people ?? []) {
    if (person.organizationId) neededByClub.set(person.organizationId, (neededByClub.get(person.organizationId) ?? 0) + 1);
  }
  return (
    <section className="page-stack">
      <div className="intro-actions club-admin-links">
        <BackLink href={`/more?event=${event.id}`} variant="staff">Back to More</BackLink>
        <Link className="secondary-button" href={`/more/clubs/reports?event=${event.id}`}>
          <FileText aria-hidden="true" size={14} /> All clubs&apos; monthly reports
        </Link>
        {teamSettings && <Link className="secondary-button" href={`/more/team-results?event=${event.id}`}>Team results</Link>}
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
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Registered clubs</caption>
              <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Club</th><th role="columnheader" scope="col">Going</th>{backgroundFlags && <th role="columnheader" scope="col">Sterling Volunteers</th>}<th role="columnheader" scope="col">Registration</th><th role="columnheader" scope="col"><span className="sr-only">Open</span></th></tr></thead>
              <tbody role="rowgroup">
                {clubs.map((club, index) => (
                  <tr role="row" key={`${club.organizationId}:${club.teamKey}`}>
                    <th role="rowheader" scope="row" translate="no">{club.teamName ? `${club.teamName} (${club.name})` : club.name}{club.sponsoringChurch && <small> · {club.sponsoringChurch}</small>}</th>
                    <td {...cardCell("Going")}>{club.attendeeCount}</td>
                    {backgroundFlags && (
                      <td {...cardCell("Sterling Volunteers")}>
                        {/* Sterling Volunteers records are the club's, not a team's (#809): a club's count shows once, on its first team. */}
                        {clubs.findIndex((other) => other.organizationId === club.organizationId) !== index
                          ? <small className="quiet-copy">Club-wide, shown above</small>
                          : neededByClub.get(club.organizationId)
                            ? <><BackgroundCheckBadge /> <small className="quiet-copy">{neededByClub.get(club.organizationId)}{club.teamName ? " (club-wide)" : ""}</small></>
                            : <small className="quiet-copy">All current</small>}
                      </td>
                    )}
                    <td {...cardCell("Registration")}>{club.confirmationCode}</td>
                    <td {...cardCell(null)}><Link className="secondary-button" href={`/more/clubs/${club.organizationId}?event=${event.id}`}>Open <ArrowRight aria-hidden="true" size={13} /></Link></td>
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
