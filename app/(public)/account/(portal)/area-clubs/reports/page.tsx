import type { Metadata } from "next";
import { AreaExportLinks, AreaMonthlyReportsTable } from "@/components/area-clubs-views";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";

export const metadata: Metadata = { title: "Monthly reports summary", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaMonthlyReportsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const clubYear = resolveAreaClubYear((await searchParams).year);
  const clubs = await getAreaClubsSummary(clubYear);
  return (
    <section className="public-manage-card page-stack">
      <h2>Monthly reports, {clubYear}</h2>
      <p className="field-help">
        Points for each submitted month. <strong>Missing</strong> means the due date (the 10th of the next month) has passed.
        Select a submitted month to read that report.
      </p>
      <AreaExportLinks
        basePath="/api/attendee/area-clubs/export"
        clubYear={clubYear}
        reports={[{ key: "summary", label: "Download summary CSV" }]}
      />
      <AreaMonthlyReportsTable
        clubYear={clubYear}
        clubs={clubs}
        links={{
          clubHref: (id) => `/account/area/${id}`,
          reportHref: (id, month) => `/account/area/${id}/reports/${month}`,
        }}
      />
    </section>
  );
}
