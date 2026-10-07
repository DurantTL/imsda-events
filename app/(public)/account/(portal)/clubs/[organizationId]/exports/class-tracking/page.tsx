import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { cardCell } from "@/components/table-card-labels";
import { PrintReportButton } from "@/components/print-report-button";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { CLASS_TRACKING_EXPORT_HEADERS } from "@/modules/reporting/director-exports";
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
            <table aria-labelledby="class-report-heading" className="report-table table-cards" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  {/* The same headings as the CSV (#811), with the member's two name columns shown as one. */}
                  <th role="columnheader" scope="col">Member</th>
                  {CLASS_TRACKING_EXPORT_HEADERS.slice(2).map((header) => <th key={header} role="columnheader" scope="col">{header}</th>)}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {rows.map((row) => (
                  <tr key={row.personId} role="row">
                    <th role="rowheader" scope="row">{row.lastName}, {row.firstName}</th>
                    {[row.className, cell(row.insignia), cell(row.eventPatches), cell(row.conductAndTlt), cell(row.masterAwards)].map((value, index) => (
                      <td key={CLASS_TRACKING_EXPORT_HEADERS[index + 2]} {...cardCell(CLASS_TRACKING_EXPORT_HEADERS[index + 2])}>{value}</td>
                    ))}
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
