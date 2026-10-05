import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { KitchenReportView } from "@/components/kitchen-report-view";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveEventContext } from "@/modules/events/selection";
import { loadKitchenReport } from "@/modules/registrations/kitchen-report-loader";

export const metadata: Metadata = { title: staffPageTitles.kitchenReport };

/** Kitchen report (#787). VIEW_REPORTS only: it holds counts and anonymous answers, so it needs no sensitive or health access. */
export default async function KitchenReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requestedEvent = Array.isArray(params.event) ? params.event[0] : params.event;
  const { event, permissions } = await resolveEventContext(requestedEvent);
  if (!permissions.includes("VIEW_REPORTS")) {
    return <AccessRestricted title="The kitchen report is restricted" detail="Your event role does not include access to reports." />;
  }
  const report = await loadKitchenReport(event.id);
  return <KitchenReportView eventName={event.name} report={report} csvHref={`/api/events/${encodeURIComponent(event.id)}/exports/kitchen`} />;
}
