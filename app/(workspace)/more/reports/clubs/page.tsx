import type { Metadata } from "next";
import Link from "next/link";
import { Download, PackageOpen, ShieldCheck, Tent } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { LocationFilter } from "@/components/location-filter";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { getClubEventReports } from "@/modules/reporting/club-event-reports-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";
import { staffPageTitles } from "@/components/staff-navigation";
import { cardCell } from "@/components/table-card-labels";

export const metadata: Metadata = { title: staffPageTitles.clubReports };
export const dynamic = "force-dynamic";

function reportDownloadHref(eventId: string, kind: string, locationId: string | null) {
  return `/api/events/${encodeURIComponent(eventId)}/club-reports?report=${kind}${locationId ? `&location=${encodeURIComponent(locationId)}` : ""}`;
}

export default async function ClubEventReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; location?: string }>;
}) {
  const { event: requested, location: requestedLocation } = await searchParams;
  const { event, allowed, readOnly } = await resolveClubReportsAccess(requested);
  if (!allowed) {
    return (
      <AccessRestricted
        title="Camporee club reports are restricted"
        detail="Ask an event administrator for report access, or for Pathfinder event-manager oversight of this club event."
      />
    );
  }
  const eventQuery = `event=${encodeURIComponent(event.id)}`;
  // Each location on its own, or all of them combined with the location named (#413).
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const reports = await getClubEventReports(event.id, { locationId });
  const showLocation = locations.length > 0;

  return (
    <section className="page-stack reports-workspace">
      <div className="page-intro report-page-intro">
        <div>
          <p className="eyebrow">Event-day planning</p>
          <h2 className="duplicate-page-title">{staffPageTitles.clubReports}</h2>
          <p>Camping coordinator, duties and activities, spiritual milestones, and special roles for {event.name}, built from each club&apos;s registration.{readOnly ? " View only." : ""}</p>
        </div>
        <div className="intro-actions report-actions">
          <Link className="secondary-button" href={`/more/reports?${eventQuery}`}>Back to reports</Link>
          <Link className="secondary-button" href={`/more/reports/clubs/check-in-book?${eventQuery}`}>Check-in book</Link>
          <PrintReportButton />
        </div>
      </div>

      <LocationFilter basePath="/more/reports/clubs" locations={locations} params={{ event: event.id }} selectedId={locationId} />

      <div className="report-safety-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <p><strong>No birth dates or protected free text.</strong> Only submitted and confirmed club registrations count. Waitlisted and cancelled clubs are excluded.</p>
      </div>

      <section className="panel report-panel" id="club-camping">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <span className="report-icon navy"><Tent aria-hidden="true" size={19} /></span>
            <div><p className="eyebrow">Camping coordinator</p><h2>Camping summary</h2><p>Campsite footprint and headcounts by role, one row per club.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "camping", locationId)}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.camping.length === 0 ? <p className="report-empty">No active club registrations yet.</p> : (
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Club camping summary</caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">Club</th>{showLocation && <th role="columnheader" scope="col">Location</th>}<th role="columnheader" scope="col">Tents</th><th role="columnheader" scope="col">Trailers</th>
                  <th role="columnheader" scope="col">Kitchen canopy</th><th role="columnheader" scope="col">Total sq ft</th><th role="columnheader" scope="col">Camp next to</th>
                  <th role="columnheader" scope="col">PF</th><th role="columnheader" scope="col">TLT</th><th role="columnheader" scope="col">Staff</th><th role="columnheader" scope="col">Child</th><th role="columnheader" scope="col">Total</th>
                  <th role="columnheader" scope="col"><span className="sr-only">Print packet</span></th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {reports.camping.map((row) => (
                  <tr role="row" key={row.organizationId}>
                    <th role="rowheader" scope="row" translate="no">{row.organizationName}{row.sponsoringChurch && <small> · {row.sponsoringChurch}</small>}</th>
                    {showLocation && <td {...cardCell("Location")} translate="no">{row.locationName ?? "—"}</td>}
                    <td {...cardCell("Tents")}>{row.camping.tents}</td>
                    <td {...cardCell("Trailers")}>{row.camping.trailers}</td>
                    <td {...cardCell("Kitchen canopy")}>{row.camping.kitchenCanopy}</td>
                    <td {...cardCell("Total sq ft")}>{row.camping.totalSqft}</td>
                    <td {...cardCell("Camp next to")}>{row.camping.campNextTo || "—"}</td>
                    <td {...cardCell("PF")}>{row.headcounts.pathfinder}</td>
                    <td {...cardCell("TLT")}>{row.headcounts.tlt}</td>
                    <td {...cardCell("Staff")}>{row.headcounts.staff}</td>
                    <td {...cardCell("Child")}>{row.headcounts.child}</td>
                    <td {...cardCell("Total")}><strong>{row.headcounts.total}</strong></td>
                    <td {...cardCell(null)}><Link className="report-record-link" href={`/more/reports/clubs/packet/${encodeURIComponent(row.organizationId)}?${eventQuery}`}><PackageOpen aria-hidden="true" size={13} /> Packet</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel report-panel" id="club-duties">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <div><p className="eyebrow">Program planning</p><h2>Duties and activities</h2><p>Each club&apos;s preferences, and staff&apos;s assignment (#410) once it exists.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "duties-activities", locationId)}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.dutiesActivities.length === 0 ? <p className="report-empty">No active club registrations yet.</p> : (
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Club duties and activities</caption>
              <thead role="rowgroup">
                <tr role="row"><th role="columnheader" scope="col">Club</th>{showLocation && <th role="columnheader" scope="col">Location</th>}<th role="columnheader" scope="col">Duty areas</th><th role="columnheader" scope="col">Activities</th><th role="columnheader" scope="col">Assigned campsite</th><th role="columnheader" scope="col">Assigned duty</th><th role="columnheader" scope="col">Assigned activity</th></tr>
              </thead>
              <tbody role="rowgroup">
                {reports.dutiesActivities.map((row) => (
                  <tr role="row" key={row.organizationId}>
                    <th role="rowheader" scope="row" translate="no">{row.organizationName}</th>
                    {showLocation && <td {...cardCell("Location")} translate="no">{row.locationName ?? "—"}</td>}
                    <td {...cardCell("Duty areas")}>{row.dutyAreas.join(", ") || "—"}</td>
                    <td {...cardCell("Activities")}>{row.specialActivities.join(", ") || "—"}</td>
                    <td {...cardCell("Assigned campsite")}>{row.assignment?.campsiteLocation || "Not assigned"}</td>
                    <td {...cardCell("Assigned duty")}>{row.assignment ? [row.assignment.dutyLabel, row.assignment.dutyDay, row.assignment.dutyTime].filter(Boolean).join(" · ") || "Not assigned" : "Not assigned"}</td>
                    <td {...cardCell("Assigned activity")}>{row.assignment?.activityLabel || "Not assigned"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel report-panel" id="club-milestones">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <div><p className="eyebrow">Pastoral follow-up</p><h2>Spiritual milestones</h2><p>Baptism interest and Bible read-through names, per club.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "milestones", locationId)}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.milestones.length === 0 ? <p className="report-empty">No club has submitted a baptism or Bible read-through name yet.</p> : (
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Club spiritual milestones</caption>
              <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Club</th>{showLocation && <th role="columnheader" scope="col">Location</th>}<th role="columnheader" scope="col">Baptism interest</th><th role="columnheader" scope="col">Bible read-through</th></tr></thead>
              <tbody role="rowgroup">
                {reports.milestones.map((row) => (
                  <tr role="row" key={row.organizationId}>
                    <th role="rowheader" scope="row" translate="no">{row.organizationName}</th>
                    {showLocation && <td {...cardCell("Location")} translate="no">{row.locationName ?? "—"}</td>}
                    <td {...cardCell("Baptism interest")}>{row.baptismNames || "—"}</td>
                    <td {...cardCell("Bible read-through")}>{row.bibleNames || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel report-panel" id="club-special-roles">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <div><p className="eyebrow">Staffing</p><h2>Special roles</h2><p>Medical personnel and Master Guide investiture candidates, across every club.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "special-roles", locationId)}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.specialRoles.length === 0 ? <p className="report-empty">No club has flagged medical personnel or a Master Guide candidate yet.</p> : (
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Special roles</caption>
              <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Role</th><th role="columnheader" scope="col">Name</th><th role="columnheader" scope="col">Club</th>{showLocation && <th role="columnheader" scope="col">Location</th>}</tr></thead>
              <tbody role="rowgroup">
                {reports.specialRoles.map((row) => (
                  <tr role="row" key={`${row.role}-${row.attendeeId}`}>
                    <td {...cardCell("Role")}>{row.role}</td>
                    <th role="rowheader" scope="row" translate="no">{row.name}</th>
                    <td {...cardCell("Club")} translate="no">{row.organizationName}</td>
                    {showLocation && <td {...cardCell("Location")} translate="no">{row.locationName ?? "—"}</td>}
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

