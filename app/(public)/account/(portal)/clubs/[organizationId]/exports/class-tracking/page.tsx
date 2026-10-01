import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { PrintReportButton } from "@/components/print-report-button";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { loadClassTrackingExport } from "@/modules/reporting/director-exports-repository";

export const metadata: Metadata = { title: "Class tracking report" };
export const dynamic = "force-dynamic";

const cell = (values: readonly string[]) => values.join("; ");

/** The printable class tracking report (#655). Names, class and earned item names only. */
export default async function ClubClassTrackingReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const { clubYear, choices } = rosterYearView(query.year);
  const { rows } = await loadClassTrackingExport(organizationId, clubYear);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}/class-tracking`}>Back to class tracking</BackLink>
      <section className="panel" aria-labelledby="class-report-heading">
        <h2 id="class-report-heading">Class tracking report: {access.club.name}, {clubYear}</h2>
        <form className="report-actions" method="get">
          <label>Club year
            <select defaultValue={clubYear} name="year">
              {choices.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
          <button className="secondary-button" type="submit">Apply</button>
        </form>
        <div className="report-actions">
          <a className="secondary-button" href={`/api/attendee/clubs/${organizationId}/exports/class-tracking?year=${clubYear}`}>Download CSV</a>
          <PrintReportButton label="Print" />
        </div>
        {rows.length === 0 ? (
          <p className="muted">No active roster members for this club year. Add members on the Roster page first.</p>
        ) : (
          <div className="report-table-wrap">
            <table aria-labelledby="class-report-heading" className="report-table">
              <thead>
                <tr>
                  <th>Member</th><th>Class</th><th>Class insignia</th><th>Event patches</th><th>Good Conduct / TLT / other</th><th>Master Awards</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.personId}>
                    <td>{row.lastName}, {row.firstName}</td>
                    <td>{row.className}</td>
                    <td>{cell(row.insignia)}</td>
                    <td>{cell(row.eventPatches)}</td>
                    <td>{cell(row.conductAndTlt)}</td>
                    <td>{cell(row.masterAwards)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
