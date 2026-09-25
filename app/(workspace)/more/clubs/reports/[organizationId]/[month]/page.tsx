import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { ClubReportForm } from "@/components/club-report-form";
import { getPrisma } from "@/lib/prisma";
import { allowedReturnTo } from "@/lib/return-to";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { formatDueDate, isReportMonth, reportDueDate, reportMonthLabel } from "@/modules/club-reports/domain";
import { getClubReport, reportPrefill } from "@/modules/club-reports/repository";

export const metadata: Metadata = { title: "Club monthly report" };
export const dynamic = "force-dynamic";

/**
 * A club's submitted monthly report, view only, for a Pathfinder event's
 * managers (#387). Reached from the event's clubs' monthly reports grid or
 * from the club's own overview page (#428): the back link returns to
 * whichever sent the visitor here.
 */
export default async function EventClubReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; month: string }>;
  searchParams: Promise<{ event?: string; from?: string }>;
}) {
  const [{ organizationId, month }, { event: requested, from }] = await Promise.all([params, searchParams]);
  const { event, allowed } = await resolveClubOversight(requested);
  if (!allowed) return <AccessRestricted title="Club oversight is restricted" detail="Event administrators of this Pathfinder event can view club reports." />;
  if (!isReportMonth(month)) notFound();
  const club = await getPrisma().organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true } });
  if (!club || club.type !== "CLUB") notFound();
  const report = await getClubReport(organizationId, month);
  if (!report || report.status !== "SUBMITTED") notFound();
  const rosterPrefill = await reportPrefill(organizationId, new Date());
  const clubHref = `/more/clubs/${organizationId}?event=${event.id}`;
  const backHref = allowedReturnTo(from, [clubHref], `/more/clubs/reports?event=${event.id}`);
  const backLabel = backHref === clubHref ? `Back to ${club.name}` : "Back to monthly reports";
  return (
    <section className="page-stack">
      <BackLink href={backHref} variant="staff">{backLabel}</BackLink>
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
