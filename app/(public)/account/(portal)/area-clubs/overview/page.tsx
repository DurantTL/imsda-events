import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaClubSearch, AreaClubsOverview, AreaExportLinks } from "@/components/area-clubs-views";
import { filterClubsByName, parseClubQuery } from "@/modules/club-reports/area-summary-domain";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club overview", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaOverviewPage({ searchParams }: { searchParams: Promise<{ year?: string; q?: string }> }) {
  // Layouts do not re-run on navigation, so every page checks for itself (#657).
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const params = await searchParams;
  const clubYear = resolveAreaClubYear(params.year);
  const query = parseClubQuery(params.q);
  const allClubs = await getAreaClubsSummary(clubYear);
  const clubs = filterClubsByName(allClubs, query);
  return (
    <section className="public-manage-card page-stack area-overview-page">
      <h2>Overview, {clubYear}</h2>
      <p className="field-help">Every active club. Sterling Volunteers shows counts only here; open a club to see its adults.</p>
      <AreaExportLinks
        basePath="/api/attendee/area-clubs/export"
        clubYear={clubYear}
        reports={[{ key: "summary", label: "Download summary CSV" }, { key: "points", label: "Download points CSV" }]}
      />
      <AreaClubSearch basePath="/account/area-clubs/overview" clubYear={clubYear} query={query} shown={clubs.length} total={allClubs.length} />
      <AreaClubsOverview
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
