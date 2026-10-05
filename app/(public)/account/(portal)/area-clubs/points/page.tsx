import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaClubSearch, AreaExportLinks, AreaPointsChart } from "@/components/area-clubs-views";
import { filterClubsByName, parseClubQuery, parseLeaderboardSort } from "@/modules/club-reports/area-summary-domain";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club points", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaPointsPage({ searchParams }: { searchParams: Promise<{ year?: string; sort?: string; q?: string }> }) {
  // Layouts do not re-run on navigation, so every page checks for itself (#657).
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const params = await searchParams;
  const clubYear = resolveAreaClubYear(params.year);
  const query = parseClubQuery(params.q);
  const sort = parseLeaderboardSort(params.sort);
  const allClubs = await getAreaClubsSummary(clubYear, new Date(), { backgroundChecks: false });
  const clubs = filterClubsByName(allClubs, query);
  return (
    <section className="public-manage-card page-stack">
      <h2>Points, {clubYear}</h2>
      <p className="field-help">Submitted report points plus 1,500 for an on-time yearly registration.</p>
      <AreaExportLinks basePath="/api/attendee/area-clubs/export" clubYear={clubYear} reports={[{ key: "points", label: "Download points CSV" }]} />
      <AreaClubSearch basePath="/account/area-clubs/points" clubYear={clubYear} query={query} shown={clubs.length} sort={sort} total={allClubs.length} />
      <AreaPointsChart basePath="/account/area-clubs/points" clubYear={clubYear} clubs={clubs} query={query} sort={sort} />
    </section>
  );
}
