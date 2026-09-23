import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { PrintReportButton } from "@/components/print-report-button";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { buildClubSchedule, rosterGroupLabels, rosterGroupOf } from "@/modules/honors/roster-domain";
import { getHonorRosterData } from "@/modules/honors/roster-repository";

export const metadata: Metadata = { title: "Club class schedule" };
export const dynamic = "force-dynamic";

/** A director's printable schedule: who is in which class, each session (#360). */
export default async function ClubSchedulePage({
  params,
}: {
  params: Promise<{ organizationId: string; eventId: string }>;
}) {
  const { organizationId, eventId } = await params;
  const access = await getRosterAccessState(organizationId);
  // The club layout shows the sign-in and authenticator steps.
  if (access.state !== "OPEN") return null;

  const back = `/account/clubs/${organizationId}/events/${eventId}`;
  // Only this club's people are loaded; dietary answers are never read here.
  const data = await getHonorRosterData(eventId, { includeDietary: false, organizationId });
  const registered = data?.clubs.some((club) => club.id === organizationId);
  if (!data || !registered) {
    return (
      <section className="public-manage-card">
        <Link className="text-button" href={back}><ArrowLeft aria-hidden="true" size={14} /> Back to the event</Link>
        <p className="public-manage-empty">Your club isn&apos;t registered for this event, so there&apos;s no schedule yet.</p>
      </section>
    );
  }
  const schedule = buildClubSchedule(organizationId, data.sessions, data.offerings, data.enrollments, data.attendees);

  return (
    <section className="public-manage-card club-schedule">
      <div className="club-schedule-actions">
        <Link className="text-button" href={back}><ArrowLeft aria-hidden="true" size={14} /> Back to the event</Link>
        <div>
          <a className="secondary-button" href={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/schedule`}>
            <Download aria-hidden="true" size={15} /> CSV
          </a>
          <PrintReportButton label="Print" />
        </div>
      </div>
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Class schedule</p>
        <h2>{data.event.name}</h2>
      </div>
      <p className="field-help">Ages are on the first day of the event. Anyone without a class in a session shows a dash.</p>
      {schedule.people.length === 0 ? (
        <p className="public-manage-empty">No one is on your club&apos;s registration.</p>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table club-schedule-table">
            <caption className="sr-only">Classes for each person</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Age</th>
                {schedule.sessions.map((session) => <th key={session.id} scope="col">{session.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {schedule.people.map((row) => (
                <tr key={row.person.id}>
                  <th scope="row">
                    <span translate="no">{row.person.lastName}, {row.person.firstName}</span>
                    <small>{rosterGroupLabels[rosterGroupOf(row.person.attendeeType)]}</small>
                  </th>
                  <td data-label="Age">{row.person.ageOnEventDate ?? "—"}</td>
                  {schedule.sessions.map((session) => {
                    const offering = row.bySession[session.id];
                    return (
                      <td data-label={session.name} key={session.id}>
                        {offering ? <>{offering.honorName}{offering.location ? <small>{offering.location}</small> : null}</> : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
