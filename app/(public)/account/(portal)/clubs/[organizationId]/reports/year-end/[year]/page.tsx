import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubYearEndReportForm } from "@/components/club-year-end-report-form";
import { getClubRoleAccessForPage } from "@/modules/club-rosters/access";
import {
  formatReportYearDueDate,
  isReportYearReportable,
  isYearEndLockedForClub,
  reportYearSpanLabel,
} from "@/modules/club-reports/year-end-domain";
import { getYearEndView } from "@/modules/club-reports/year-end-repository";

export const metadata: Metadata = { title: "Year-End Report" };
export const dynamic = "force-dynamic";

export default async function ClubYearEndReportPage({ params }: { params: Promise<{ organizationId: string; year: string }> }) {
  const { organizationId, year } = await params;
  const access = await getClubRoleAccessForPage(organizationId);
  if (access.state !== "OK") return null;
  const backHref = `/account/clubs/${organizationId}/records`;
  if (!access.capabilities.submitReports) {
    return (
      <>
        <BackLink href={backHref}>Back to Monthly Records</BackLink>
        <p className="public-manage-empty">The Year-End Report is filed by the club&apos;s director, deputy, or reporter.</p>
      </>
    );
  }
  const now = new Date();
  if (!isReportYearReportable(year, now)) notFound();
  const view = await getYearEndView(organizationId, year, now);
  const report = view.report;
  const status = report?.status ?? null;

  return (
    <>
      <BackLink href={backHref}>Back to Monthly Records</BackLink>
      <ClubYearEndReportForm
        dueLabel={formatReportYearDueDate(year)}
        endpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/year-end-reports/${year}`}
        initialContact={{
          contactName: report?.contactName ?? "",
          contactWorkPhone: report?.contactWorkPhone ?? "",
          contactHomePhone: report?.contactHomePhone ?? "",
          contactCellPhone: report?.contactCellPhone ?? "",
          contactEmail: report?.contactEmail ?? "",
        }}
        initialResolved={view.resolved ?? report!.resolved}
        late={report?.late ?? false}
        prefillMeta={view.prefillMeta}
        readOnly={status ? isYearEndLockedForClub(status) : false}
        reportYear={year}
        spanLabel={reportYearSpanLabel(year)}
        status={status}
      />
    </>
  );
}
