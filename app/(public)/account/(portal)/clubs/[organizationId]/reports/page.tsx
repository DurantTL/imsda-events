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
  const submittedReports = reports.filter((report) => report.status === "SUBMITTED");
  const byMonth = new Map(reports.map((report) => [report.reportMonth, report]));
  const months = [...reportableMonths(clubYear, now)].reverse();
  const base = `/account/clubs/${organizationId}/reports`;

  return (
    <>
      <div className="club-home-stats">
        <div className="club-home-stat">
          <CheckCircle2 size={20} aria-hidden="true" />
          <strong>{yearToDate(submittedReports, registrationOnTime).toLocaleString("en-US")}</strong>
          <span>points this club year ({clubYear})</span>
        </div>
        <div className="club-home-stat">
          <Clock3 size={20} aria-hidden="true" />
          <strong>{submittedReports.length}</strong>
          <span>{submittedReports.length === 1 ? "report submitted" : "reports submitted"}</span>
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
            const submitted = report?.status === "SUBMITTED";
            const due = formatDueDate(reportDueDate(month));
            const locked = isLockedForClub(month, now);
            // A draft never locks; it can still be submitted after the due date.
            const closed = locked && report?.status === "SUBMITTED";
            return (
              <li key={month}>
                {submitted ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
                <span>
                  <strong>{reportMonthLabel(month)}</strong>
                  <small>
                    {report
                      ? `${report.status === "DRAFT" ? "Draft" : `${report.totalPoints} points${report.onTimePoints ? "" : " · late"}`}${closed ? " · closed" : locked ? ` · was due ${due}` : ` · editable until ${due}`}`
                      : locked ? `Missing · was due ${due}` : `Due ${due}`}
                  </small>
                </span>
                <Link className={`${report ? "secondary-button" : "primary-button"} club-event-action`} href={`${base}/${month}`}>
                  {closed ? "View report" : "Open report"} <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
