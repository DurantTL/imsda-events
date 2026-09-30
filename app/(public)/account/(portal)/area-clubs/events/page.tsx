import type { Metadata } from "next";
import { AreaClubEvents } from "@/components/area-clubs-views";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { listAreaClubEvents } from "@/modules/club-reports/area-summary-repository";

export const metadata: Metadata = { title: "Club events", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

export default async function AreaEventsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const clubYear = resolveAreaClubYear((await searchParams).year);
  const events = await listAreaClubEvents(clubYear);
  return (
    <section className="page-stack">
      <div className="public-manage-card">
        <h2>Club events, {clubYear}</h2>
        <p className="field-help">Each club&apos;s registration status and headcount. Only registered clubs count toward an event&apos;s total.</p>
      </div>
      <AreaClubEvents clubHref={(id) => `/account/area/${id}`} events={events} />
    </section>
  );
}
