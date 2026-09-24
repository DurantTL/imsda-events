import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClubReportForm } from "@/components/club-report-form";
import { monthlyNotesSummary } from "@/modules/club-meeting-notes/repository";
import { getClubRoleAccess } from "@/modules/club-rosters/access";
import { calendarDateIn } from "@/modules/calendar/domain";
import {
  ON_TIME_POINTS,
  formatDueDate,
  isLockedForClub,
  isReportMonth,
  reportDueDate,
  reportMonthLabel,
} from "@/modules/club-reports/domain";
import { getClubReport, reportPrefill } from "@/modules/club-reports/repository";

export const metadata: Metadata = { title: "Monthly report" };
export const dynamic = "force-dynamic";

export default async function ClubReportPage({ params }: { params: Promise<{ organizationId: string; month: string }> }) {
  const { organizationId, month } = await params;
  const access = await getClubRoleAccess(organizationId);
  if (access.state !== "OK") return null;
  if (!access.capabilities.submitReports) {
    return <p className="public-manage-empty">Monthly reports are filed by the club&apos;s director, deputy, or reporter.</p>;
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
      <Link className="text-button club-report-back" href={`/account/clubs/${organizationId}/reports`}>← All monthly reports</Link>
      <ClubReportForm
        allowDraft
        dueLabel={formatDueDate(due)}
        endpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/reports/${month}`}
        expectedOnTime={locked ? 0 : ON_TIME_POINTS}
        initial={report}
        monthLabel={reportMonthLabel(month)}
        notesPrefill={notesPrefill}
        prefill={prefill}
        readOnly={Boolean(report) && locked}
        reopenEndpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/reports/${month}/reopen`}
      />
    </>
  );
}
