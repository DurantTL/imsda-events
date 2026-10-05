import Link from "next/link";
import { Download, Search } from "lucide-react";
import {
  eventHeadcount,
  eventStatusLabels,
  monthStatusLabels,
  pointsChartDescription,
  sortLeaderboard,
  type AreaClubSummary,
  type LeaderboardSort,
} from "@/modules/club-reports/area-summary-domain";
import type { AreaClubEvent } from "@/modules/club-reports/area-summary-repository";
import { reportMonthLabel } from "@/modules/club-reports/domain";
import { cardCell } from "@/components/table-card-labels";
import { SortOrderNote } from "@/components/list-sort";

/**
 * Read-only cross-club report views shared by the Area Coordinator's Clubs
 * section and the conference office. `clubHref` / `reportHref` let each
 * workspace link to its own view-only club and report pages. Counts and
 * points only: background checks are counts, never names or notes.
 */

const shortMonth = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
const formatNumber = (value: number) => value.toLocaleString("en-US");

export type AreaLinks = {
  clubHref: (organizationId: string) => string;
  reportHref: (organizationId: string, month: string) => string;
};

/** What an empty club list says: nothing matched the search, or there are no clubs at all. */
const noClubsText = (query?: string) => (query ? `No club name matches “${query}”.` : "No active clubs yet.");

/**
 * A club-name search for the area-coordinator tabs (#791). A plain GET form, so
 * it works without scripts and the address keeps the search; the year and sort
 * are carried along. The page filters on the server with `filterClubsByName`.
 */
export function AreaClubSearch({ basePath, clubYear, query, sort, shown, total }: { basePath: string; clubYear: string; query: string; sort?: LeaderboardSort; shown: number; total: number }) {
  return (
    <form action={basePath} className="area-club-search" method="get" role="search">
      <input name="year" type="hidden" value={clubYear} />
      {sort && <input name="sort" type="hidden" value={sort} />}
      <label className="search-field" htmlFor="area-club-search">
        <Search aria-hidden="true" size={15} />
        <span className="sr-only">Search clubs by name</span>
        <input autoComplete="off" defaultValue={query} id="area-club-search" maxLength={80} name="q" placeholder="Search clubs by name" type="search" />
      </label>
      <button className="secondary-button" type="submit">Search</button>
      {query && <Link className="text-button" href={`${basePath}?year=${encodeURIComponent(clubYear)}${sort ? `&sort=${sort}` : ""}`}>Clear</Link>}
      <small aria-live="polite" role="status">{query ? `${shown} of ${total} clubs match` : ""}</small>
    </form>
  );
}

export function AreaClubsOverview({ clubs, clubYear, links, query }: { clubs: AreaClubSummary[]; clubYear: string; links: AreaLinks; query?: string }) {
  if (clubs.length === 0) return <p className="report-empty">{noClubsText(query)}</p>;
  return (
    <div className="report-table-wrap">
      <table role="table" className="report-table table-cards">
        <caption className="sr-only">Club overview for {clubYear}</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Club</th>
            <th role="columnheader" scope="col">Director</th>
            <th role="columnheader" scope="col">Church</th>
            <th role="columnheader" scope="col">Roster</th>
            <th role="columnheader" scope="col">Reports submitted</th>
            <th role="columnheader" scope="col">Total points</th>
            <th role="columnheader" scope="col">Last report</th>
            <th role="columnheader" scope="col">Background checks</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {clubs.map((club) => (
            <tr role="row" key={club.id}>
              <th role="rowheader" scope="row" translate="no"><Link href={links.clubHref(club.id)}>{club.name}</Link></th>
              <td {...cardCell("Director")} translate="no">{club.directors.length > 0 ? club.directors.join(", ") : "—"}</td>
              <td {...cardCell("Church")} translate="no">{club.church || "—"}</td>
              <td {...cardCell("Roster")}>{club.rosterSize}</td>
              <td {...cardCell("Reports submitted")}>{club.submitted}{club.late > 0 && <small> ({club.late} late)</small>}</td>
              <td {...cardCell("Total points")}><strong>{formatNumber(club.totalPoints)}</strong></td>
              <td {...cardCell("Last report")}>{club.lastReportMonth ? reportMonthLabel(club.lastReportMonth) : "None yet"}</td>
              <td {...cardCell("Background checks")}>
                {/* Counts only: who and why stay with the club (#479). */}
                {club.backgroundChecks.notInCompliance} not in compliance · {club.backgroundChecks.expiringSoon} expiring soon · {club.backgroundChecks.missing} missing
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AreaMonthlyReportsTable({ clubs, clubYear, links, query }: { clubs: AreaClubSummary[]; clubYear: string; links: AreaLinks; query?: string }) {
  if (clubs.length === 0) return <p className="report-empty">{noClubsText(query)}</p>;
  const months = clubs[0]!.months.map((cell) => cell.month);
  return (
    <div className="report-table-wrap club-reports-grid">
      <table role="table" className="report-table table-cards">
        <caption className="sr-only">Monthly report status and points by club for {clubYear}</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Club</th>
            {months.map((month) => <th key={month} role="columnheader" scope="col">{shortMonth(month)}</th>)}
            <th role="columnheader" scope="col">Submitted</th>
            <th role="columnheader" scope="col">Draft</th>
            <th role="columnheader" scope="col">Missing</th>
            <th role="columnheader" scope="col">Total points</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {clubs.map((club) => (
            <tr role="row" key={club.id}>
              <th role="rowheader" scope="row" translate="no">{club.name}{club.church && <small>{club.church}</small>}</th>
              {club.months.map((cell) => {
                if (cell.status === "SUBMITTED" || cell.status === "LATE") {
                  return (
                    <td key={cell.month} {...cardCell(shortMonth(cell.month))}>
                      <Link href={links.reportHref(club.id, cell.month)}>{cell.points}</Link>
                      {cell.status === "LATE" && <small> late</small>}
                    </td>
                  );
                }
                if (cell.status === "FUTURE") return <td key={cell.month} {...cardCell(shortMonth(cell.month))} className="club-reports-future"><span aria-hidden="true">—</span><span className="sr-only">{monthStatusLabels.FUTURE}</span></td>;
                return (
                  <td key={cell.month} {...cardCell(shortMonth(cell.month))} className={cell.status === "MISSING" ? "club-reports-missing" : "club-reports-due"}>
                    {monthStatusLabels[cell.status]}
                  </td>
                );
              })}
              <td {...cardCell("Submitted")}>{club.submitted}{club.late > 0 && <small> ({club.late} late)</small>}</td>
              <td {...cardCell("Draft")}>{club.drafts}</td>
              <td {...cardCell("Missing")}>{club.missing}</td>
              <td {...cardCell("Total points")}><strong>{formatNumber(club.totalPoints)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Horizontal bar chart in plain SVG (no chart library). The figure has a text
 * description, the bars are hidden from assistive tech, and the data table
 * right below it carries every number. One row per club, so it reads on a phone.
 */
export function AreaPointsChart({ clubs, clubYear, sort, basePath, query }: { clubs: AreaClubSummary[]; clubYear: string; sort: LeaderboardSort; basePath: string; query?: string }) {
  const sorted = sortLeaderboard(clubs, sort);
  const max = Math.max(1, ...sorted.map((club) => club.totalPoints));
  const sortHref = (value: LeaderboardSort) => `${basePath}?year=${encodeURIComponent(clubYear)}&sort=${value}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  return (
    <>
      <SortOrderNote>{sort === "name" ? "Sorted by club name, A to Z." : "Sorted by total points, highest first."}</SortOrderNote>
      <p className="field-help">
        Sort by{" "}
        {sort === "points" ? <strong>points</strong> : <Link href={sortHref("points")}>points</Link>}
        {" · "}
        {sort === "name" ? <strong>club name</strong> : <Link href={sortHref("name")}>club name</Link>}
      </p>
      {sorted.length === 0 ? <p className="report-empty">{noClubsText(query)}</p> : (
        <>
          <figure className="area-points-chart">
            <figcaption>Total points per club, {clubYear}</figcaption>
            <ul aria-label={pointsChartDescription(sorted, clubYear)} role="img">
              {sorted.map((club) => (
                <li key={club.id}>
                  <span className="area-points-chart-label"><span translate="no">{club.name}</span><strong>{formatNumber(club.totalPoints)}</strong></span>
                  <svg aria-hidden="true" focusable="false" preserveAspectRatio="none" viewBox="0 0 100 6">
                    <rect fill="var(--line, #d6dee2)" height="6" rx="1" width="100" x="0" y="0" />
                    <rect fill="currentColor" height="6" rx="1" width={Math.max(0.5, (club.totalPoints / max) * 100)} x="0" y="0" />
                  </svg>
                </li>
              ))}
            </ul>
          </figure>
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Total points per club for {clubYear}, in chart order</caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">Rank</th>
                  <th role="columnheader" scope="col">Club</th>
                  <th role="columnheader" scope="col">Report points</th>
                  <th role="columnheader" scope="col">Yearly registration</th>
                  <th role="columnheader" scope="col">Total points</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {sorted.map((club, index) => (
                  <tr role="row" key={club.id}>
                    <td {...cardCell("Rank")}>{index + 1}</td>
                    <th role="rowheader" scope="row" translate="no">{club.name}</th>
                    <td {...cardCell("Report points")}>{formatNumber(club.reportPoints)}</td>
                    <td {...cardCell("Yearly registration")}>{formatNumber(club.totalPoints - club.reportPoints)}</td>
                    <td {...cardCell("Total points")}><strong>{formatNumber(club.totalPoints)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function AreaClubEvents({ events, clubHref, query }: { events: AreaClubEvent[]; clubHref: (organizationId: string) => string; query?: string }) {
  if (events.length === 0) return <p className="report-empty">{query ? noClubsText(query) : "No club events this club year."}</p>;
  return (
    <>
      {events.map((event) => (
        <section className="panel report-panel" key={event.id}>
          <div className="section-heading">
            <div>
              <h3 translate="no">{event.name}</h3>
              <p className="field-help">
                {new Date(event.startsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}
                {" · "}{event.clubs.filter((club) => club.status === "REGISTERED").length} clubs registered · {formatNumber(eventHeadcount(event.clubs))} people
              </p>
            </div>
            <Link className="secondary-button" href={`/account/area-clubs/kitchen/${encodeURIComponent(event.id)}`}>Kitchen report</Link>
          </div>
          <div className="report-table-wrap">
            <table role="table" className="report-table table-cards">
              <caption className="sr-only">Club registrations for {event.name}</caption>
              <thead role="rowgroup">
                <tr role="row"><th role="columnheader" scope="col">Club</th><th role="columnheader" scope="col">Status</th><th role="columnheader" scope="col">Headcount</th></tr>
              </thead>
              <tbody role="rowgroup">
                {event.clubs.map((club) => (
                  <tr role="row" key={club.organizationId}>
                    <th role="rowheader" scope="row" translate="no"><Link href={clubHref(club.organizationId)}>{club.name}</Link></th>
                    <td {...cardCell("Status")}>{eventStatusLabels[club.status]}</td>
                    <td {...cardCell("Headcount")}>{club.headcount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

export function AreaExportLinks({ basePath, clubYear, reports }: { basePath: string; clubYear: string; reports: Array<{ key: "summary" | "points"; label: string }> }) {
  return (
    <div className="intro-actions">
      {reports.map((report) => (
        <a className="secondary-button" href={`${basePath}?report=${report.key}&year=${encodeURIComponent(clubYear)}`} key={report.key}>
          <Download aria-hidden="true" size={15} /> {report.label}
        </a>
      ))}
    </div>
  );
}
