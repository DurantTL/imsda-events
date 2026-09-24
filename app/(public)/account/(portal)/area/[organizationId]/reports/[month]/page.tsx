import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClubReportForm } from "@/components/club-report-form";
import { getPrisma } from "@/lib/prisma";
import { formatDueDate, isReportMonth, reportDueDate, reportMonthLabel } from "@/modules/club-reports/domain";
import { getClubReport, reportPrefill } from "@/modules/club-reports/repository";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Monthly report", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/** A club's submitted monthly report, view only, for an Area Coordinator (#387). */
export default async function AreaClubReportPage({ params }: { params: Promise<{ organizationId: string; month: string }> }) {
  const coordinator = await currentAreaCoordinator();
  if (!coordinator) notFound();
  const { organizationId, month } = await params;
  if (!isReportMonth(month)) notFound();
  const club = await getPrisma().organization.findUnique({ where: { id: organizationId }, select: { type: true, name: true, isActive: true } });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();
  const report = await getClubReport(organizationId, month);
  if (!report || report.status !== "SUBMITTED") notFound();
  const rosterPrefill = await reportPrefill(organizationId, new Date());
  const prefill = { ...rosterPrefill, averageAttendance: null, honors: [] };

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1 translate="no">{club.name}</h1>
        </div>
      </section>
      <div className="account-page-body">
        <Link className="text-button club-report-back" href={`/account/area/${organizationId}`}>← Back to the club</Link>
        <ClubReportForm
          dueLabel={formatDueDate(reportDueDate(month))}
          endpoint="/api/attendee/area-report-read-only"
          expectedOnTime={0}
          initial={report}
          monthLabel={reportMonthLabel(month)}
          prefill={prefill}
          readOnly
          readOnlyNote="View only. The club files and changes its own reports."
        />
      </div>
    </>
  );
}
