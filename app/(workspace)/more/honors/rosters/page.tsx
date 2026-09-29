import type { Metadata } from "next";
import Link from "next/link";
import { Award, Download, ShieldCheck, UsersRound } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { BackgroundCheckBadge } from "@/components/background-check-flags";
import { LocationFilter } from "@/components/location-filter";
import { PrintReportButton } from "@/components/print-report-button";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { resolveEventContext } from "@/modules/events/selection";
import {
  buildClassRosters,
  buildClubSchedule,
  buildSiteRoster,
  allSitesLabel,
  rosterGroupLabels,
  rosterGroupOf,
} from "@/modules/honors/roster-domain";
import { getHonorRosterData } from "@/modules/honors/roster-repository";
import { backgroundFlaggedAttendeeIds } from "@/modules/background-checks/repository";

export const metadata: Metadata = {
  title: "Honors Weekend rosters",
  robots: { index: false, follow: false, nocache: true },
};

type View = "classes" | "site" | "clubs";

function ageText(age: number | null) {
  return age === null ? "—" : String(age);
}

export default async function HonorRostersPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; view?: string; club?: string; location?: string }>;
}) {
  const query = await searchParams;
  const { event, permissions } = await resolveEventContext(query.event);
  if (!permissions.includes("VIEW_REPORTS")) {
    return <AccessRestricted title="Honors rosters are restricted" detail="Ask an event administrator for report access." />;
  }
  const includeDietary = permissions.includes("VIEW_SENSITIVE_DATA");
  // "All sites" plus each location, from the filter the other staff views share (#413).
  const { locations, locationId, selected: site } = await resolveLocationFilter(event.id, query.location);
  const [data, flagged] = await Promise.all([
    getHonorRosterData(event.id, { includeDietary, ...(locationId ? { locationId } : {}) }),
    backgroundFlaggedAttendeeIds(event.id),
  ]);
  if (!data) return <AccessRestricted title="Event unavailable" detail="The selected event could not be loaded." />;

  const view: View = query.view === "site" || query.view === "clubs" ? query.view : "classes";
  const eventQuery = `event=${encodeURIComponent(event.id)}${site ? `&location=${encodeURIComponent(site.id)}` : ""}`;
  const csv = (kind: string, club?: string) =>
    `/api/events/${encodeURIComponent(event.id)}/honors/rosters?view=${kind}${club ? `&club=${encodeURIComponent(club)}` : ""}${site ? `&location=${encodeURIComponent(site.id)}` : ""}`;
  const classRosters = buildClassRosters(data.sessions, data.offerings, data.enrollments, data.attendees, data.locations);
  const siteRoster = buildSiteRoster(data.attendees);
  const selectedClubs = query.club ? data.clubs.filter((club) => club.id === query.club) : data.clubs;

  return (
    <section className="page-stack reports-workspace honor-rosters">
      <div className="page-intro report-page-intro">
        <div>
          <p className="eyebrow">Honors Weekend</p>
          <h2>Rosters for {data.event.name}</h2>
          <p>
            Class sheets, the site check-in roster, and each club&apos;s schedule, from submitted club registrations.
            Ages are on the first day of the event.
          </p>
        </div>
        <div className="intro-actions report-actions">
          <Link className="secondary-button" href={`/more/honors?${eventQuery}`}>Back to classes</Link>
          <PrintReportButton label="Print" />
        </div>
      </div>

      <div className="report-safety-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <p>
          <strong>Ages only, never birth dates.</strong>{" "}
          {includeDietary
            ? "Dietary notes appear on the site roster because you can view sensitive answers. Keep printed copies with the kitchen and check-in team."
            : "Dietary notes are left off because your role can't view sensitive answers."}
        </p>
      </div>

      <nav className="retreat-packet-selector" aria-label="Roster view">
        <Link className={view === "classes" ? "active" : ""} href={`/more/honors/rosters?${eventQuery}`}>Classes ({classRosters.length})</Link>
        <Link className={view === "site" ? "active" : ""} href={`/more/honors/rosters?${eventQuery}&view=site`}>Site roster ({siteRoster.totals.total})</Link>
        <Link className={view === "clubs" ? "active" : ""} href={`/more/honors/rosters?${eventQuery}&view=clubs`}>Club schedules ({data.clubs.length})</Link>
      </nav>

      <LocationFilter
        basePath="/more/honors/rosters"
        locations={locations}
        params={{ event: event.id, view: view === "classes" ? undefined : view, club: query.club }}
        selectedId={locationId}
      />

      {view === "classes" && (
        <>
          <div className="report-actions honor-roster-downloads">
            <a className="secondary-button report-download" href={csv("classes")}><Download aria-hidden="true" size={15} /> Download class rosters CSV</a>
          </div>
          {classRosters.length === 0 && <p className="report-empty">No classes are set up for {site ? <span translate="no">{site.name}</span> : "this site"} yet.</p>}
          {classRosters.map((roster) => (
            <section className="panel report-panel honor-class-sheet" key={roster.offering.id}>
              <div className="section-heading report-section-heading">
                <div className="report-title">
                  <span className="report-icon purple"><Award aria-hidden="true" size={19} /></span>
                  <div>
                    <p className="eyebrow">
                      {data.hasLocations && <><span translate="no">{roster.siteName ?? allSitesLabel}</span>{" · "}</>}
                      {roster.session}{roster.offering.isActive ? "" : " · no longer offered"}
                    </p>
                    <h2>{roster.offering.honorName} <small>{roster.offering.honorCode}</small></h2>
                    <p>
                      {[roster.offering.location && `Room: ${roster.offering.location}`, roster.offering.teacherName && `Teacher: ${roster.offering.teacherName}`]
                        .filter(Boolean).join(" · ") || "Room and teacher not set"}
                    </p>
                  </div>
                </div>
                <span className="count-badge">{roster.youthSeats} / {roster.offering.capacity} youth seats</span>
              </div>
              {roster.people.length === 0 ? (
                <p className="report-empty">No one has chosen this class yet.</p>
              ) : (
                <div className="report-table-wrap">
                  <table className="report-table">
                    <caption className="sr-only">People in {roster.offering.honorName}</caption>
                    <thead><tr><th scope="col">Name</th><th scope="col">Club</th><th scope="col">Age</th><th scope="col">Type</th><th scope="col">Present</th></tr></thead>
                    <tbody>
                      {roster.people.map((person) => (
                        <tr key={person.id}>
                          <th scope="row" translate="no">{person.lastName}, {person.firstName}{flagged.has(person.id) && <> <BackgroundCheckBadge /></>}</th>
                          <td translate="no">{person.clubName}</td>
                          <td>{ageText(person.ageOnEventDate)}</td>
                          <td>{rosterGroupLabels[rosterGroupOf(person.attendeeType)]}</td>
                          <td className="honor-roster-box" aria-label="Attendance box" />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </>
      )}

      {view === "site" && (
        <section className="panel report-panel">
          <div className="section-heading report-section-heading">
            <div className="report-title">
              <span className="report-icon navy"><UsersRound aria-hidden="true" size={19} /></span>
              <div>
                <p className="eyebrow">Check-in fallback</p>
                <h2>Site roster</h2>
                <p>
                  {siteRoster.totals.YOUTH} youth · {siteRoster.totals.STAFF} staff · {siteRoster.totals.ADULT} adults · {siteRoster.totals.total} total.
                  Use QR check-in first; this sheet is the paper backup.
                </p>
              </div>
            </div>
            <a className="secondary-button report-download" href={csv("site")}><Download aria-hidden="true" size={15} /> Download site roster CSV</a>
          </div>
          {siteRoster.clubs.length > 0 && (
            <div className="report-table-wrap">
              <table className="report-table">
                <caption className="sr-only">Totals by club</caption>
                <thead><tr><th scope="col">Club</th><th scope="col">Youth</th><th scope="col">Staff</th><th scope="col">Adults</th></tr></thead>
                <tbody>
                  {siteRoster.clubs.map((club) => (
                    <tr key={club.clubName}><th scope="row" translate="no">{club.clubName}</th><td>{club.YOUTH}</td><td>{club.STAFF}</td><td>{club.ADULT}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {siteRoster.people.length === 0 ? (
            <p className="report-empty">No club has registered for this site yet.</p>
          ) : (
            <div className="report-table-wrap">
              <table className="report-table">
                <caption className="sr-only">Everyone registered for this site</caption>
                <thead>
                  <tr>
                    <th scope="col">Checked in</th><th scope="col">Name</th><th scope="col">Club</th>{data.hasLocations && <th scope="col">Site</th>}<th scope="col">Age</th><th scope="col">Type</th>
                    {includeDietary && <th scope="col">Dietary notes</th>}
                  </tr>
                </thead>
                <tbody>
                  {siteRoster.people.map((person) => (
                    <tr key={person.id}>
                      <td className="honor-roster-box">{person.checkedIn ? "✓" : ""}</td>
                      <th scope="row" translate="no">{person.lastName}, {person.firstName}{flagged.has(person.id) && <> <BackgroundCheckBadge /></>}</th>
                      <td translate="no">{person.clubName}</td>
                      {data.hasLocations && <td translate="no">{person.locationName ?? "—"}</td>}
                      <td>{ageText(person.ageOnEventDate)}</td>
                      <td>{rosterGroupLabels[rosterGroupOf(person.attendeeType)]}</td>
                      {includeDietary && <td>{person.dietary ?? ""}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {view === "clubs" && (
        <>
          {data.clubs.length > 1 && (
            <nav className="retreat-packet-selector" aria-label="Choose club">
              <Link className={!query.club ? "active" : ""} href={`/more/honors/rosters?${eventQuery}&view=clubs`}>All clubs</Link>
              {data.clubs.map((club) => (
                <Link className={query.club === club.id ? "active" : ""} href={`/more/honors/rosters?${eventQuery}&view=clubs&club=${encodeURIComponent(club.id)}`} key={club.id}>
                  {club.name}
                </Link>
              ))}
            </nav>
          )}
          {data.clubs.length === 0 && <p className="report-empty">No club has registered for this site yet.</p>}
          {selectedClubs.map((club) => {
            const schedule = buildClubSchedule(club.id, data.sessions, data.offerings, data.enrollments, data.attendees, data.locations);
            return (
              <section className="panel report-panel" key={club.id}>
                <div className="section-heading report-section-heading">
                  <div className="report-title">
                    <span className="report-icon green"><UsersRound aria-hidden="true" size={19} /></span>
                    <div><p className="eyebrow">Club schedule</p><h2 translate="no">{club.name}</h2><p>{schedule.people.length} people{schedule.siteName ? <> · Site: <span translate="no">{schedule.siteName}</span></> : null}</p></div>
                  </div>
                  <a className="secondary-button report-download" href={csv("club", club.id)}><Download aria-hidden="true" size={15} /> Download CSV</a>
                </div>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <caption className="sr-only">Classes for {club.name}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Name</th><th scope="col">Age</th>
                        {schedule.sessions.map((session) => <th key={session.id} scope="col">{session.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.people.map((row) => (
                        <tr key={row.person.id}>
                          <th scope="row" translate="no">{row.person.lastName}, {row.person.firstName}{flagged.has(row.person.id) && <> <BackgroundCheckBadge /></>}</th>
                          <td>{ageText(row.person.ageOnEventDate)}</td>
                          {schedule.sessions.map((session) => {
                            const offering = row.bySession[session.id];
                            return (
                              <td key={session.id}>
                                {offering ? <>{offering.honorName}{offering.location ? <><br /><small>{offering.location}</small></> : null}</> : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
