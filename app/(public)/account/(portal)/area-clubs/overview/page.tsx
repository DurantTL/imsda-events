import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaClubsOverview, AreaExportLinks } from "@/components/area-clubs-views";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club overview", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaOverviewPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  // Layouts do not re-run on navigation, so every page checks for itself (#657).
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const clubYear = resolveAreaClubYear((await searchParams).year);
  const clubs = await getAreaClubsSummary(clubYear);
  return (
    <section className="public-manage-card page-stack">
      <h2>Overview, {clubYear}</h2>
      <p className="field-help">Every active club. Background checks show counts only, never names or notes.</p>
      <AreaExportLinks
        basePath="/api/attendee/area-clubs/export"
        clubYear={clubYear}
        reports={[{ key: "summary", label: "Download summary CSV" }, { key: "points", label: "Download points CSV" }]}
      />
      <AreaClubsOverview
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
