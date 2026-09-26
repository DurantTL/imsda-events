import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubReportForm } from "@/components/club-report-form";
import { monthlyNotesSummary } from "@/modules/club-meeting-notes/repository";
import { getClubRoleAccessForPage } from "@/modules/club-rosters/access";
import { calendarDateIn } from "@/modules/calendar/domain";
import {
  ON_TIME_POINTS,
  formatDueDate,
  isLockedForClub,
  onTimePoints,
  isReportMonth,
  reportDueDate,
  reportMonthLabel,
} from "@/modules/club-reports/domain";
import { getClubReport, reportPrefill } from "@/modules/club-reports/repository";

export const metadata: Metadata = { title: "Monthly report" };
export const dynamic = "force-dynamic";

export default async function ClubReportPage({ params }: { params: Promise<{ organizationId: string; month: string }> }) {
  const { organizationId, month } = await params;
  const access = await getClubRoleAccessForPage(organizationId);
  if (access.state !== "OK") return null;
  if (!access.capabilities.submitReports) {
    return (
      <>
        <BackLink href={`/account/clubs/${organizationId}/reports`}>Back to monthly reports</BackLink>
        <p className="public-manage-empty">Monthly reports are filed by the club&apos;s director, deputy, or reporter.</p>
      </>
    );
  }
  const now = new Date();
  if (!isReportMonth(month) || month > calendarDateIn(now).slice(0, 7)) notFound();
  const [report, rosterPrefill, notesPrefill] = await Promise.all([
    getClubReport(organizationId, month),
    reportPrefill(organizationId, now),
    monthlyNotesSummary(organizationId, month),
  ]);
  const due = reportDueDate(month);
  const locked = isLockedForClub(month, now);
  // A brand new report prefills from meeting notes when there are any; a saved draft or
  // submitted report is never overwritten here — "Refresh from meeting notes" does that instead.
  const prefill = {
    ...rosterPrefill,
    averageAttendance: notesPrefill?.averageAttendance ?? null,
    pathfinderCount: notesPrefill?.pathfinderCount ?? rosterPrefill.pathfinderCount,
    tltCount: notesPrefill?.tltCount ?? rosterPrefill.tltCount,
    staffCount: notesPrefill?.staffCount ?? rosterPrefill.staffCount,
    honors: notesPrefill?.honors ?? [],
  };

  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}/reports`}>Back to monthly reports</BackLink>
      <ClubReportForm
        allowDraft
        dueLabel={formatDueDate(due)}
        endpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/reports/${month}`}
        expectedOnTime={report?.firstSubmittedAt ? onTimePoints(month, new Date(report.firstSubmittedAt)) : locked ? 0 : ON_TIME_POINTS}
        initial={report}
        monthLabel={reportMonthLabel(month)}
        notesPrefill={notesPrefill}
        prefill={prefill}
        readOnly={report?.status === "SUBMITTED" && locked}
        reopenEndpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/reports/${month}/reopen`}
      />
    </>
  );
}
