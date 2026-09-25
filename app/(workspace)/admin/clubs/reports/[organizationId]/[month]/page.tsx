import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubReportForm } from "@/components/club-report-form";
import { getCurrentSession } from "@/modules/access/current-session";
import { allowedReturnTo } from "@/lib/return-to";
import { getPrisma } from "@/lib/prisma";
import { calendarDateIn } from "@/modules/calendar/domain";
import { ON_TIME_POINTS, formatDueDate, isLockedForClub, isReportMonth, reportDueDate, reportMonthLabel } from "@/modules/club-reports/domain";
import { getClubReport, reportPrefill } from "@/modules/club-reports/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";

export const metadata: Metadata = { title: "Club monthly report" };
export const dynamic = "force-dynamic";

/**
 * Conference staff open, file, or correct any club's report, even after it
 * closes (#377). Reached from the conference-wide monthly reports grid or
 * from the club's own overview page (#428): the back link returns to
 * whichever sent the visitor here.
 */
export default async function StaffClubReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; month: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId, month } = await params;
  const { from } = await searchParams;
  const now = new Date();
  if (!isReportMonth(month) || month > calendarDateIn(now).slice(0, 7)) notFound();
  const club = await getPrisma().organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true } });
  if (!club || club.type !== "CLUB") notFound();
  const [report, rosterPrefill] = await Promise.all([getClubReport(organizationId, month), reportPrefill(organizationId, now)]);
  const prefill = { ...rosterPrefill, averageAttendance: null, honors: [] };
  const clubYear = clubYearFor(new Date(`${month}-15T12:00:00Z`));
  const clubHref = `/admin/organizations/${organizationId}/club`;
  const backHref = allowedReturnTo(from, [clubHref], `/admin/clubs/reports?year=${clubYear}`);
  const backLabel = backHref === clubHref ? `Back to ${club.name}` : "Back to monthly reports";
  return (
    <section className="page-stack">
      <BackLink href={backHref} variant="staff">{backLabel}</BackLink>
      <div className="page-intro"><div><p className="eyebrow">Monthly report</p><h2 translate="no">{club.name}</h2></div></div>
      <ClubReportForm
        dueLabel={formatDueDate(reportDueDate(month))}
        endpoint={`/api/admin/club-reports/${encodeURIComponent(organizationId)}/${month}`}
        expectedOnTime={isLockedForClub(month, now) ? 0 : ON_TIME_POINTS}
        initial={report}
        monthLabel={reportMonthLabel(month)}
        prefill={prefill}
        readOnly={false}
        variant="staff"
      />
    </section>
  );
}
