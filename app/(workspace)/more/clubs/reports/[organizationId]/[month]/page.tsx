import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { ClubReportForm } from "@/components/club-report-form";
import { getPrisma } from "@/lib/prisma";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { formatDueDate, isReportMonth, reportDueDate, reportMonthLabel } from "@/modules/club-reports/domain";
import { getClubReport, reportPrefill } from "@/modules/club-reports/repository";

export const metadata: Metadata = { title: "Club monthly report" };
export const dynamic = "force-dynamic";

/** A club's submitted monthly report, view only, for a Pathfinder event's managers (#387). */
export default async function EventClubReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; month: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const [{ organizationId, month }, { event: requested }] = await Promise.all([params, searchParams]);
  const { event, allowed } = await resolveClubOversight(requested);
  if (!allowed) return <AccessRestricted title="Club oversight is restricted" detail="Event administrators of this Pathfinder event can view club reports." />;
  if (!isReportMonth(month)) notFound();
  const club = await getPrisma().organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true } });
  if (!club || club.type !== "CLUB") notFound();
  const report = await getClubReport(organizationId, month);
  if (!report || report.status !== "SUBMITTED") notFound();
  const rosterPrefill = await reportPrefill(organizationId, new Date());
  return (
    <section className="page-stack">
      <Link className="secondary-button more-back-link" href={`/more/clubs/reports?event=${event.id}`}>Back to monthly reports</Link>
      <div className="page-intro"><div><p className="eyebrow">Monthly report · view only</p><h2 translate="no">{club.name}</h2></div></div>
      <ClubReportForm
        dueLabel={formatDueDate(reportDueDate(month))}
        endpoint="/api/admin/club-reports/view-only"
        expectedOnTime={0}
        initial={report}
        monthLabel={reportMonthLabel(month)}
        prefill={{ ...rosterPrefill, averageAttendance: null, honors: [] }}
        readOnly
        readOnlyNote="View only. The club files and changes its own reports."
        variant="staff"
      />
    </section>
  );
}
