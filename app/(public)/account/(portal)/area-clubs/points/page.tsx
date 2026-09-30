import type { Metadata } from "next";
import { AreaExportLinks, AreaPointsChart } from "@/components/area-clubs-views";
import { parseLeaderboardSort } from "@/modules/club-reports/area-summary-domain";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";

export const metadata: Metadata = { title: "Club points", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaPointsPage({ searchParams }: { searchParams: Promise<{ year?: string; sort?: string }> }) {
  const params = await searchParams;
  const clubYear = resolveAreaClubYear(params.year);
  const clubs = await getAreaClubsSummary(clubYear);
  return (
    <section className="public-manage-card page-stack">
      <h2>Points, {clubYear}</h2>
      <p className="field-help">Submitted report points plus 1,500 for an on-time yearly registration.</p>
      <AreaExportLinks basePath="/api/attendee/area-clubs/export" clubYear={clubYear} reports={[{ key: "points", label: "Download points CSV" }]} />
      <AreaPointsChart basePath="/account/area-clubs/points" clubYear={clubYear} clubs={clubs} sort={parseLeaderboardSort(params.sort)} />
    </section>
  );
}
