import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { KitchenReportView } from "@/components/kitchen-report-view";
import { loadAreaKitchenReport } from "@/modules/registrations/kitchen-report-loader";

export const metadata: Metadata = { title: "Kitchen report", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/** Kitchen report for an Area Coordinator (#787): the whole club event, counts only. */
export default async function AreaKitchenReportPage({ params }: { params: Promise<{ eventId: string }> }) {
  // Layouts do not re-run on navigation, so the loader checks the coordinator itself.
  const { eventId } = await params;
  const result = await loadAreaKitchenReport(eventId);
  if (!result) notFound();
  return <KitchenReportView eventName={result.eventName} report={result.report} csvHref={`/api/attendee/area-clubs/kitchen/${encodeURIComponent(eventId)}`} />;
}
