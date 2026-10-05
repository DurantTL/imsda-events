import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { PrintReportButton } from "@/components/print-report-button";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { honorCategoryLabels } from "@/modules/honors/domain";
import { honorsSummary } from "@/modules/reporting/director-exports";
import { isHonorCategory, listExportMemberOptions, loadHonorsExport } from "@/modules/reporting/director-exports-repository";

export const metadata: Metadata = { title: "Honors report" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The printable honors report (#655), with the same filters as the CSV. Names and honors only. */
export default async function ClubHonorsReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const { clubYear, choices } = rosterYearView(one(query.year));
  const category = isHonorCategory(one(query.category)) ? one(query.category) : "";
  const memberId = one(query.member);
  const [{ rows }, members] = await Promise.all([
    loadHonorsExport(organizationId, clubYear, { memberId: memberId || undefined, category: category || undefined }),
    listExportMemberOptions(organizationId, clubYear),
  ]);
  const summary = honorsSummary(rows);
  const csvParams = new URLSearchParams({ year: clubYear });
  if (memberId) csvParams.set("member", memberId);
  if (category) csvParams.set("category", category);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}/honors`}>Back to honors</BackLink>
      <section className="panel honors-report-panel" aria-labelledby="honors-report-heading">
        <h2 id="honors-report-heading">Honors report: {access.club.name}, {clubYear}</h2>
        <form className="report-actions" method="get">
          <label>Club year
            <select defaultValue={clubYear} name="year">
              {choices.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
          <label>Member
            <select defaultValue={memberId} name="member">
              <option value="">All members</option>
              {members.map((member) => <option key={member.memberId} value={member.memberId}>{member.label}</option>)}
            </select>
          </label>
          <label>Category
            <select defaultValue={category} name="category">
              <option value="">All categories</option>
              {Object.entries(honorCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button className="secondary-button" type="submit">Apply filters</button>
        </form>
        <div className="report-actions">
          <a className="secondary-button" href={`/api/attendee/clubs/${organizationId}/exports/honors?${csvParams.toString()}`}>Download CSV</a>
          <PrintReportButton label="Print" />
        </div>
        {rows.length === 0 ? (
          <p className="muted">No honors recorded for the chosen filters. If the roster is empty, add members on the Roster page first.</p>
        ) : (
          <div className="report-table-wrap">
            <table aria-labelledby="honors-report-heading" className="report-table honors-report-table">
              <colgroup>
                <col style={{ width: "18%" }} /><col style={{ width: "11%" }} /><col style={{ width: "23%" }} /><col style={{ width: "13%" }} />
                <col style={{ width: "10%" }} /><col style={{ width: "13%" }} /><col style={{ width: "12%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Member</th><th>Class</th><th>Honor</th><th>Category</th><th>Status</th><th>Date</th><th>Event</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.memberId}-${row.honorId}`}>
                    <td>{row.lastName}, {row.firstName}</td>
                    <td>{row.className}</td>
                    <td>{row.honorName}</td>
                    <td>{row.category}</td>
                    <td>{row.status}</td>
                    <td>{row.dateEarned ? `${row.dateEarned} (${row.dateKind.toLowerCase()})` : "No date"}</td>
                    <td>{row.eventName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>Completed honors per honor</h3>
        {summary.length === 0 ? (
          <p className="muted">No completed honors.</p>
        ) : (
          <div className="report-table-wrap">
            <table aria-label="Completed honors per honor" className="report-table honors-report-table">
              <thead><tr><th>Honor</th><th>Category</th><th>Count</th></tr></thead>
              <tbody>
                {summary.map((entry) => (
                  <tr key={entry.honorName}><td>{entry.honorName}</td><td>{entry.category}</td><td>{entry.count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
