import Link from "next/link";
import { Award, CalendarDays, CheckCircle2, CircleAlert, FileText, ShieldCheck, UsersRound } from "lucide-react";
import { formatDueDate, type MonthlyReportProgress } from "@/modules/club-reports/domain";
import type { RosterYearSummary } from "@/modules/club-rosters/domain";
import type { HonorYearSummary } from "@/modules/honors/member-honor-domain";

/**
 * The club-year dashboard (#488): roster, honors, background checks, events,
 * and monthly reports at a glance, each tile linking to where the work is
 * done. Every tile is built from data its caller already loaded — no new
 * queries and no new data entry. Each `href` is the caller's own choice: a
 * director links to the club's own roster/honors/events/reports pages, while
 * a read-only viewer whose page already shows that section inline can point
 * at its anchor on the same page instead.
 */

export type EventsTileSummary = { open: number; registered: number };

/** Background-check counts only (#479) — never a name, so this is safe for any caller allowed the roster's counts. */
export type ComplianceTileSummary = { missing: number; notInCompliance: number; expiringSoon: number };

export function ClubYearTiles({
  roster,
  rosterHref,
  honors,
  honorsHref,
  compliance,
  complianceHref,
  events,
  eventsHref,
  reports,
  reportsHref,
}: {
  roster: RosterYearSummary;
  rosterHref: string;
  /** Null hides the tile: honors are visible to anyone who can view the roster, but a caller may not have loaded them. */
  honors: HonorYearSummary | null;
  honorsHref: string;
  /** Null hides the tile: the viewer isn't allowed background-check information at all. */
  compliance: ComplianceTileSummary | null;
  complianceHref: string;
  events: EventsTileSummary;
  eventsHref: string;
  /** Null hides the tile: the viewer's role doesn't submit or see reports. */
  reports: MonthlyReportProgress | null;
  reportsHref: string;
}) {
  const complianceTotal = compliance ? compliance.missing + compliance.notInCompliance + compliance.expiringSoon : 0;
  return (
    <div className="club-year-tiles">
      <div className="club-year-tile">
        <h3 className="club-year-tile-heading"><UsersRound size={16} aria-hidden="true" /> Roster</h3>
        <p className="club-year-tile-stat">{roster.active}</p>
        <p className="club-year-tile-detail">active this club year · {roster.staff} staff · {roster.members} members</p>
        {roster.byClass.length > 0 && (
          <ul className="club-year-tile-list">
            {roster.byClass.map((entry) => <li key={entry.classLevel}>{entry.label} {entry.count}</li>)}
          </ul>
        )}
        <Link className="secondary-button club-year-tile-link" href={rosterHref}>Open roster</Link>
      </div>

      {honors && (
        <div className="club-year-tile">
          <h3 className="club-year-tile-heading"><Award size={16} aria-hidden="true" /> Honors</h3>
          {honors.inProgress === 0 && honors.completedThisYear === 0 ? (
            <p className="club-year-tile-detail">None recorded yet this club year.</p>
          ) : (
            <ul className="club-year-tile-list">
              {honors.inProgress > 0 && <li>{honors.inProgress} in progress</li>}
              {honors.completedThisYear > 0 && <li>{honors.completedThisYear} completed this year</li>}
            </ul>
          )}
          <Link className="secondary-button club-year-tile-link" href={honorsHref}>Open honors</Link>
        </div>
      )}

      {compliance && (
        <div className="club-year-tile">
          <h3 className="club-year-tile-heading"><ShieldCheck size={16} aria-hidden="true" /> Background checks</h3>
          {complianceTotal === 0 ? (
            <p className="club-year-tile-detail"><CheckCircle2 size={15} aria-hidden="true" /> All current.</p>
          ) : (
            <ul className="club-year-tile-list">
              {compliance.missing > 0 && <li><CircleAlert size={13} aria-hidden="true" /> {compliance.missing} missing</li>}
              {compliance.notInCompliance > 0 && <li><CircleAlert size={13} aria-hidden="true" /> {compliance.notInCompliance} not in compliance</li>}
              {compliance.expiringSoon > 0 && <li><CircleAlert size={13} aria-hidden="true" /> {compliance.expiringSoon} expiring soon</li>}
            </ul>
          )}
          <Link className="secondary-button club-year-tile-link" href={complianceHref}>Review background checks</Link>
        </div>
      )}

      <div className="club-year-tile">
        <h3 className="club-year-tile-heading"><CalendarDays size={16} aria-hidden="true" /> Events</h3>
        <p className="club-year-tile-stat">{events.open}</p>
        <p className="club-year-tile-detail">
          {events.open === 1 ? "event open to register" : "events open to register"} · {events.registered} registered
        </p>
        <Link className="secondary-button club-year-tile-link" href={eventsHref}>Open events</Link>
      </div>

      {reports && (
        <div className="club-year-tile">
          <h3 className="club-year-tile-heading"><FileText size={16} aria-hidden="true" /> Monthly reports</h3>
          <p className="club-year-tile-stat">{reports.filed}</p>
          <p className="club-year-tile-detail">
            filed this club year
            {reports.missing > 0 && ` · ${reports.missing} missing`}
            {reports.dueSoon && ` · ${reports.dueSoon.count} due ${formatDueDate(reports.dueSoon.dueDate)}`}
            {reports.missing === 0 && !reports.dueSoon && " · none missing"}
          </p>
          <Link className="secondary-button club-year-tile-link" href={reportsHref}>Open monthly reports</Link>
        </div>
      )}
    </div>
  );
}
