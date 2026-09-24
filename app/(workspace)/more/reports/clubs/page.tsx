import type { Metadata } from "next";
import Link from "next/link";
import { Download, PackageOpen, ShieldCheck, Tent } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { getClubEventReports } from "@/modules/reporting/club-event-reports-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";

export const metadata: Metadata = { title: "Camporee club reports" };
export const dynamic = "force-dynamic";

function reportDownloadHref(eventId: string, kind: string) {
  return `/api/events/${encodeURIComponent(eventId)}/club-reports?report=${kind}`;
}

export default async function ClubEventReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event: requested } = await searchParams;
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
  const reports = await getClubEventReports(event.id);

  return (
    <section className="page-stack reports-workspace">
      <div className="page-intro report-page-intro">
        <div>
          <p className="eyebrow">Event-day planning</p>
          <h2>Camporee club reports</h2>
          <p>Camping coordinator, duties and activities, spiritual milestones, and special roles for {event.name}, built from each club&apos;s registration.{readOnly ? " View only." : ""}</p>
        </div>
        <div className="intro-actions report-actions">
          <Link className="secondary-button" href={`/more/reports?${eventQuery}`}>Back to reports</Link>
          <PrintReportButton />
        </div>
      </div>

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
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "camping")}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.camping.length === 0 ? <p className="report-empty">No active club registrations yet.</p> : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Club camping summary</caption>
              <thead>
                <tr>
                  <th scope="col">Club</th><th scope="col">Tents</th><th scope="col">Trailers</th>
                  <th scope="col">Kitchen canopy</th><th scope="col">Total sq ft</th><th scope="col">Camp next to</th>
                  <th scope="col">PF</th><th scope="col">TLT</th><th scope="col">Staff</th><th scope="col">Child</th><th scope="col">Total</th>
                  <th scope="col"><span className="sr-only">Print packet</span></th>
                </tr>
              </thead>
              <tbody>
                {reports.camping.map((row) => (
                  <tr key={row.organizationId}>
                    <th scope="row" translate="no">{row.organizationName}{row.sponsoringChurch && <small> · {row.sponsoringChurch}</small>}</th>
                    <td>{row.camping.tents}</td>
                    <td>{row.camping.trailers}</td>
                    <td>{row.camping.kitchenCanopy}</td>
                    <td>{row.camping.totalSqft}</td>
                    <td>{row.camping.campNextTo || "—"}</td>
                    <td>{row.headcounts.pathfinder}</td>
                    <td>{row.headcounts.tlt}</td>
                    <td>{row.headcounts.staff}</td>
                    <td>{row.headcounts.child}</td>
                    <td><strong>{row.headcounts.total}</strong></td>
                    <td><Link className="report-record-link" href={`/more/reports/clubs/packet/${encodeURIComponent(row.organizationId)}?${eventQuery}`}><PackageOpen aria-hidden="true" size={13} /> Packet</Link></td>
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
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "duties-activities")}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.dutiesActivities.length === 0 ? <p className="report-empty">No active club registrations yet.</p> : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Club duties and activities</caption>
              <thead>
                <tr><th scope="col">Club</th><th scope="col">Duty areas</th><th scope="col">Activities</th><th scope="col">Assigned campsite</th><th scope="col">Assigned duty</th><th scope="col">Assigned activity</th></tr>
              </thead>
              <tbody>
                {reports.dutiesActivities.map((row) => (
                  <tr key={row.organizationId}>
                    <th scope="row" translate="no">{row.organizationName}</th>
                    <td>{row.dutyAreas.join(", ") || "—"}</td>
                    <td>{row.specialActivities.join(", ") || "—"}</td>
                    <td>{row.assignment?.campsiteLocation || "Not assigned"}</td>
                    <td>{row.assignment ? [row.assignment.dutyLabel, row.assignment.dutyDay, row.assignment.dutyTime].filter(Boolean).join(" · ") || "Not assigned" : "Not assigned"}</td>
                    <td>{row.assignment?.activityLabel || "Not assigned"}</td>
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
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "milestones")}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.milestones.length === 0 ? <p className="report-empty">No club has submitted a baptism or Bible read-through name yet.</p> : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Club spiritual milestones</caption>
              <thead><tr><th scope="col">Club</th><th scope="col">Baptism interest</th><th scope="col">Bible read-through</th></tr></thead>
              <tbody>
                {reports.milestones.map((row) => (
                  <tr key={row.organizationId}>
                    <th scope="row" translate="no">{row.organizationName}</th>
                    <td>{row.baptismNames || "—"}</td>
                    <td>{row.bibleNames || "—"}</td>
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
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "special-roles")}><Download aria-hidden="true" size={15} /> Download CSV</a>
        </div>
        {reports.specialRoles.length === 0 ? <p className="report-empty">No club has flagged medical personnel or a Master Guide candidate yet.</p> : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Special roles</caption>
              <thead><tr><th scope="col">Role</th><th scope="col">Name</th><th scope="col">Club</th></tr></thead>
              <tbody>
                {reports.specialRoles.map((row) => (
                  <tr key={`${row.role}-${row.attendeeId}`}>
                    <td>{row.role}</td>
                    <th scope="row" translate="no">{row.name}</th>
                    <td translate="no">{row.organizationName}</td>
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

