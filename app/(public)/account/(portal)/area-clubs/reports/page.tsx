import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaClubSearch, AreaExportLinks, AreaMonthlyReportsTable } from "@/components/area-clubs-views";
import { filterClubsByName, parseClubQuery } from "@/modules/club-reports/area-summary-domain";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Monthly reports summary", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaMonthlyReportsPage({ searchParams }: { searchParams: Promise<{ year?: string; q?: string }> }) {
  // Layouts do not re-run on navigation, so every page checks for itself (#657).
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const params = await searchParams;
  const clubYear = resolveAreaClubYear(params.year);
  const query = parseClubQuery(params.q);
  const allClubs = await getAreaClubsSummary(clubYear, new Date(), { backgroundChecks: false });
  const clubs = filterClubsByName(allClubs, query);
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
      <AreaClubSearch basePath="/account/area-clubs/reports" clubYear={clubYear} query={query} shown={clubs.length} total={allClubs.length} />
      <AreaMonthlyReportsTable
        query={query}
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
