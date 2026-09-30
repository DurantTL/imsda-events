import Link from "next/link";
import { Download } from "lucide-react";
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

export function AreaClubsOverview({ clubs, clubYear, links }: { clubs: AreaClubSummary[]; clubYear: string; links: AreaLinks }) {
  if (clubs.length === 0) return <p className="report-empty">No active clubs yet.</p>;
  return (
    <div className="report-table-wrap">
      <table className="report-table table-cards">
        <caption className="sr-only">Club overview for {clubYear}</caption>
        <thead>
          <tr>
            <th scope="col">Club</th>
            <th scope="col">Director</th>
            <th scope="col">Church</th>
            <th scope="col">Roster</th>
            <th scope="col">Reports submitted</th>
            <th scope="col">Total points</th>
            <th scope="col">Last report</th>
            <th scope="col">Background checks</th>
          </tr>
        </thead>
        <tbody>
          {clubs.map((club) => (
            <tr key={club.id}>
              <th scope="row" translate="no"><Link href={links.clubHref(club.id)}>{club.name}</Link></th>
              <td translate="no">{club.directors.length > 0 ? club.directors.join(", ") : "—"}</td>
              <td translate="no">{club.church || "—"}</td>
              <td>{club.rosterSize}</td>
              <td>{club.submitted}{club.late > 0 && <small> ({club.late} late)</small>}</td>
              <td><strong>{formatNumber(club.totalPoints)}</strong></td>
              <td>{club.lastReportMonth ? reportMonthLabel(club.lastReportMonth) : "None yet"}</td>
              <td>
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

export function AreaMonthlyReportsTable({ clubs, clubYear, links }: { clubs: AreaClubSummary[]; clubYear: string; links: AreaLinks }) {
  if (clubs.length === 0) return <p className="report-empty">No active clubs yet.</p>;
  const months = clubs[0]!.months.map((cell) => cell.month);
  return (
    <div className="report-table-wrap club-reports-grid">
      <table className="report-table table-cards">
        <caption className="sr-only">Monthly report status and points by club for {clubYear}</caption>
        <thead>
          <tr>
            <th scope="col">Club</th>
            {months.map((month) => <th key={month} scope="col">{shortMonth(month)}</th>)}
            <th scope="col">Submitted</th>
            <th scope="col">Draft</th>
            <th scope="col">Missing</th>
            <th scope="col">Total points</th>
          </tr>
        </thead>
        <tbody>
          {clubs.map((club) => (
            <tr key={club.id}>
              <th scope="row" translate="no">{club.name}{club.church && <small>{club.church}</small>}</th>
              {club.months.map((cell) => {
                if (cell.status === "SUBMITTED" || cell.status === "LATE") {
                  return (
                    <td key={cell.month}>
                      <Link href={links.reportHref(club.id, cell.month)}>{cell.points}</Link>
                      {cell.status === "LATE" && <small> late</small>}
                    </td>
                  );
                }
                if (cell.status === "FUTURE") return <td key={cell.month} className="club-reports-future"><span aria-hidden="true">—</span><span className="sr-only">{monthStatusLabels.FUTURE}</span></td>;
                return (
                  <td key={cell.month} className={cell.status === "MISSING" ? "club-reports-missing" : "club-reports-due"}>
                    {monthStatusLabels[cell.status]}
                  </td>
                );
              })}
              <td>{club.submitted}{club.late > 0 && <small> ({club.late} late)</small>}</td>
              <td>{club.drafts}</td>
              <td>{club.missing}</td>
              <td><strong>{formatNumber(club.totalPoints)}</strong></td>
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
export function AreaPointsChart({ clubs, clubYear, sort, basePath }: { clubs: AreaClubSummary[]; clubYear: string; sort: LeaderboardSort; basePath: string }) {
  const sorted = sortLeaderboard(clubs, sort);
  const max = Math.max(1, ...sorted.map((club) => club.totalPoints));
  const sortHref = (value: LeaderboardSort) => `${basePath}?year=${encodeURIComponent(clubYear)}&sort=${value}`;
  return (
    <>
      <p className="field-help">
        Sort by{" "}
        {sort === "points" ? <strong>points</strong> : <Link href={sortHref("points")}>points</Link>}
        {" · "}
        {sort === "name" ? <strong>club name</strong> : <Link href={sortHref("name")}>club name</Link>}
      </p>
      {sorted.length === 0 ? <p className="report-empty">No active clubs yet.</p> : (
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
            <table className="report-table table-cards">
              <caption className="sr-only">Total points per club for {clubYear}, in chart order</caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Club</th>
                  <th scope="col">Report points</th>
                  <th scope="col">Yearly registration</th>
                  <th scope="col">Total points</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((club, index) => (
                  <tr key={club.id}>
                    <td>{index + 1}</td>
                    <th scope="row" translate="no">{club.name}</th>
                    <td>{formatNumber(club.reportPoints)}</td>
                    <td>{formatNumber(club.totalPoints - club.reportPoints)}</td>
                    <td><strong>{formatNumber(club.totalPoints)}</strong></td>
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

export function AreaClubEvents({ events, clubHref }: { events: AreaClubEvent[]; clubHref: (organizationId: string) => string }) {
  if (events.length === 0) return <p className="report-empty">No club events this club year.</p>;
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
          </div>
          <div className="report-table-wrap">
            <table className="report-table table-cards">
              <caption className="sr-only">Club registrations for {event.name}</caption>
              <thead>
                <tr><th scope="col">Club</th><th scope="col">Status</th><th scope="col">Headcount</th></tr>
              </thead>
              <tbody>
                {event.clubs.map((club) => (
                  <tr key={club.organizationId}>
                    <th scope="row" translate="no"><Link href={clubHref(club.organizationId)}>{club.name}</Link></th>
                    <td>{eventStatusLabels[club.status]}</td>
                    <td>{club.headcount ?? "—"}</td>
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
