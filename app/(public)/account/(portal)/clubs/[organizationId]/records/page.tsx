import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleAlert } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { ClubMeetingNotes } from "@/components/club-meeting-notes";
import { ClubReportForm } from "@/components/club-report-form";
import { calendarDateIn } from "@/modules/calendar/domain";
import { defaultMeetingDate, recordsMonth } from "@/modules/club-meeting-notes/domain";
import { listAttendanceRoster, listClubMeetingNotes, monthlyNotesSummary } from "@/modules/club-meeting-notes/repository";
import {
  ON_TIME_POINTS,
  clubYearMonths,
  formatDueDate,
  isLockedForClub,
  onTimePoints,
  reportDueDate,
  reportMonthLabel,
} from "@/modules/club-reports/domain";
import { getClubReport, getClubReportYear, reportPrefill } from "@/modules/club-reports/repository";
import {
  formatReportYearDueDate,
  isPastDue,
  reportYearSpanLabel,
  reportableReportYears,
} from "@/modules/club-reports/year-end-domain";
import { listYearEndReportsForClub } from "@/modules/club-reports/year-end-repository";
import { getClubRoleAccessForPage } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";

export const metadata: Metadata = { title: "Monthly Records" };
export const dynamic = "force-dynamic";

/**
 * Monthly Records (#653): one page per month for the club year. The month's
 * meeting notes (with the optional attendance check-off) sit on top, then that
 * month's report, prefilled from the meetings as before (#426). The report's
 * submit and lock rules are the report route's and are unchanged (#640).
 */
export default async function ClubRecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const [{ organizationId }, { month: monthParam }] = await Promise.all([params, searchParams]);
  const access = await getClubRoleAccessForPage(organizationId);
  if (access.state !== "OK") return null;
  const back = <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>;
  if (!access.capabilities.submitReports) {
    return (
      <>
        {back}
        <p className="public-manage-empty">Monthly Records are kept by the club&apos;s director, deputy, or reporter.</p>
      </>
    );
  }
  const now = new Date();
  const month = recordsMonth(monthParam, now);
  const clubYear = clubYearFor(new Date(`${month}-15T12:00:00Z`));
  const currentMonth = calendarDateIn(now).slice(0, 7);
  const switcherMonths = clubYearMonths(clubYear).filter((candidate) => candidate <= currentMonth);

  const [notes, roster, report, rosterPrefill, notesPrefill, reportYear] = await Promise.all([
    listClubMeetingNotes(organizationId, month),
    listAttendanceRoster(organizationId, clubYear),
    getClubReport(organizationId, month),
    reportPrefill(organizationId, now),
    monthlyNotesSummary(organizationId, month),
    getClubReportYear(organizationId, clubYear),
  ]);
  const reportsByMonth = new Map(reportYear.reports.map((entry) => [entry.reportMonth, entry]));
  const due = reportDueDate(month);
  const locked = isLockedForClub(month, now);
  // A brand new report prefills from meeting notes when there are any; a saved draft or
  // submitted report is never overwritten here; "Refresh from meeting notes" does that instead.
  const prefill = {
    ...rosterPrefill,
    averageAttendance: notesPrefill?.averageAttendance ?? null,
    pathfinderCount: notesPrefill?.pathfinderCount ?? rosterPrefill.pathfinderCount,
    tltCount: notesPrefill?.tltCount ?? rosterPrefill.tltCount,
    staffCount: notesPrefill?.staffCount ?? rosterPrefill.staffCount,
    honors: notesPrefill?.honors ?? [],
  };
  const apiBase = `/api/attendee/clubs/${encodeURIComponent(organizationId)}`;
  const recordsBase = `/account/clubs/${organizationId}/records`;
  const yearEndYears = reportableReportYears(now);
  const yearEndReports = await listYearEndReportsForClub(organizationId, yearEndYears);

  return (
    <>
      {back}

      <nav aria-label={`Months of the ${clubYear} club year`} className="public-manage-card">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Club year {clubYear}</p>
          <h2>Monthly Records</h2>
        </div>
        <div className="intro-actions">
          {switcherMonths.map((candidate) => {
            const filed = reportsByMonth.get(candidate);
            return (
              <Link
                aria-current={candidate === month ? "page" : undefined}
                className={`${candidate === month ? "primary-button" : "secondary-button"} club-event-action`}
                href={`${recordsBase}?month=${candidate}`}
                key={candidate}
              >
                {reportMonthLabel(candidate)}
                {filed?.status === "SUBMITTED" ? " · filed" : filed ? " · draft" : ""}
              </Link>
            );
          })}
        </div>
      </nav>

      <ClubMeetingNotes
        exportHref={`${apiBase}/exports/attendance?year=${encodeURIComponent(clubYear)}`}
        initialNotes={notes}
        key={month}
        month={month}
        monthLabel={reportMonthLabel(month)}
        newMeetingDate={defaultMeetingDate(month, now)}
        organizationId={organizationId}
        roster={roster}
        rosterClubYear={clubYear}
      />

      <ClubReportForm
        allowDraft
        dueLabel={formatDueDate(due)}
        endpoint={`${apiBase}/reports/${month}`}
        expectedOnTime={report?.firstSubmittedAt ? onTimePoints(month, new Date(report.firstSubmittedAt)) : locked ? 0 : ON_TIME_POINTS}
        initial={report}
        key={`${month}:${report?.updatedAt ?? "new"}:${notesPrefill?.averageAttendance ?? ""}`}
        monthLabel={reportMonthLabel(month)}
        notesPrefill={notesPrefill}
        prefill={prefill}
        readOnly={Boolean(report?.firstSubmittedAt) && locked}
        reopenEndpoint={`${apiBase}/reports/${month}/reopen`}
      />

      <section className="public-manage-card" aria-labelledby="club-year-end-heading">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Due April 1, pre-filled from your roster, honors, and classes</p>
          <h2 id="club-year-end-heading">Year-End Report</h2>
        </div>
        <ul className="public-manage-club-list">
          {yearEndYears.map((year) => {
            const yearEnd = yearEndReports.get(year);
            const submitted = yearEnd?.status === "SUBMITTED";
            const yearEndDue = formatReportYearDueDate(year);
            return (
              <li key={year}>
                {submitted ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
                <span>
                  <strong>Pathfinder year {year}</strong>
                  <small>
                    {reportYearSpanLabel(year)} ·{" "}
                    {submitted
                      ? `Submitted${yearEnd.late ? " late" : ""} · closed`
                      : yearEnd
                        ? `Draft · ${isPastDue(year, now) ? `was due ${yearEndDue}` : `due ${yearEndDue}`}`
                        : isPastDue(year, now) ? `Not filed · was due ${yearEndDue}` : `Due ${yearEndDue}`}
                  </small>
                </span>
                <Link className={`${yearEnd ? "secondary-button" : "primary-button"} club-event-action`} href={`/account/clubs/${organizationId}/reports/year-end/${year}`}>
                  {submitted ? "View report" : "Open report"} <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
