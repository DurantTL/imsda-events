import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaClubEvents, AreaClubSearch } from "@/components/area-clubs-views";
import { filterClubsByName, parseClubQuery } from "@/modules/club-reports/area-summary-domain";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { listAreaClubEvents } from "@/modules/club-reports/area-summary-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Club events", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaEventsPage({ searchParams }: { searchParams: Promise<{ year?: string; q?: string }> }) {
  // Layouts do not re-run on navigation, so every page checks for itself (#657).
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const params = await searchParams;
  const clubYear = resolveAreaClubYear(params.year);
  const query = parseClubQuery(params.q);
  const allEvents = await listAreaClubEvents(clubYear);
  // The component narrows the rows; the counts here only feed the search status line.
  const matching = allEvents.map((event) => filterClubsByName(event.clubs, query));
  const total = new Set(allEvents.flatMap((event) => event.clubs.map((club) => club.organizationId))).size;
  const shown = new Set(matching.flat().map((club) => club.organizationId)).size;
  return (
    <section className="page-stack">
      <div className="public-manage-card">
        <h2>Club events, {clubYear}</h2>
        <p className="field-help">Each club&apos;s registration status and headcount. Only registered clubs count toward an event&apos;s total.</p>
      </div>
      <AreaClubSearch basePath="/account/area-clubs/events" clubYear={clubYear} query={query} shown={shown} total={total} />
      <AreaClubEvents query={query} clubHref={(id) => `/account/area/${id}`} events={allEvents} />
    </section>
  );
}
