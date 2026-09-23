import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleAlert, Clock3 } from "lucide-react";
import { getClubRoleAccess } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import {
  YEARLY_REGISTRATION_POINTS,
  formatDueDate,
  isLockedForClub,
  reportDueDate,
  reportMonthLabel,
  reportableMonths,
  yearToDate,
} from "@/modules/club-reports/domain";
import { getClubReportYear } from "@/modules/club-reports/repository";

export const metadata: Metadata = { title: "Monthly reports" };
export const dynamic = "force-dynamic";

/** The club's monthly reports for this club year, newest first (#377). */
export default async function ClubReportsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getClubRoleAccess(organizationId);
  if (access.state !== "OK") return null;
  if (!access.capabilities.submitReports) {
    return <p className="public-manage-empty">Monthly reports are filed by the club&apos;s director, deputy, or reporter.</p>;
  }
  const now = new Date();
  const clubYear = clubYearFor(now);
  const { reports, registrationOnTime } = await getClubReportYear(organizationId, clubYear);
  const byMonth = new Map(reports.map((report) => [report.reportMonth, report]));
  const months = [...reportableMonths(clubYear, now)].reverse();
  const base = `/account/clubs/${organizationId}/reports`;

  return (
    <>
      <div className="club-home-stats">
        <div className="club-home-stat">
          <CheckCircle2 size={20} aria-hidden="true" />
          <strong>{yearToDate(reports, registrationOnTime).toLocaleString("en-US")}</strong>
          <span>points this club year ({clubYear})</span>
        </div>
        <div className="club-home-stat">
          <Clock3 size={20} aria-hidden="true" />
          <strong>{reports.length}</strong>
          <span>{reports.length === 1 ? "report submitted" : "reports submitted"}</span>
        </div>
        <div className="club-home-stat">
          <CheckCircle2 size={20} aria-hidden="true" />
          <strong>{registrationOnTime ? YEARLY_REGISTRATION_POINTS.toLocaleString("en-US") : 0}</strong>
          <span>yearly registration points</span>
        </div>
      </div>

      <section className="public-manage-card" aria-labelledby="club-reports-heading">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Due the 10th of the next month</p>
          <h2 id="club-reports-heading">Monthly reports</h2>
        </div>
        <ul className="public-manage-club-list">
          {months.map((month) => {
            const report = byMonth.get(month);
            const due = formatDueDate(reportDueDate(month));
            const locked = isLockedForClub(month, now);
            return (
              <li key={month}>
                {report ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
                <span>
                  <strong>{reportMonthLabel(month)}</strong>
                  <small>
                    {report
                      ? `${report.totalPoints} points${report.onTimePoints ? "" : " · late"}${locked ? " · closed" : ` · editable until ${due}`}`
                      : locked ? `Missing · was due ${due}` : `Due ${due}`}
                  </small>
                </span>
                <Link className={`${report ? "secondary-button" : "primary-button"} club-event-action`} href={`${base}/${month}`}>
                  {report ? (locked ? "View" : "Edit") : "Submit"} <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
