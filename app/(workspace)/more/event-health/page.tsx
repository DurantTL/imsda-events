import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { EventHealthSheet } from "@/components/event-health-sheet";
import { PrintReportButton } from "@/components/print-report-button";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveStaffHealthViewer } from "@/modules/coordinator-health/access";
import { HealthViewError, loadEventHealth } from "@/modules/coordinator-health/repository";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = {
  title: staffPageTitles.eventHealth,
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

/**
 * Health information for a club event (#658), for system administrators and
 * staff a system administrator gave VIEW_HEALTH_INFORMATION. Access is checked
 * here on the server, not by a layout. Opening the page is audited as a view;
 * `?sheet=1` opens the printable sheet and is audited as an export.
 */
export default async function EventHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; club?: string; sheet?: string }>;
}) {
  const query = await searchParams;
  const { event } = await resolveEventContext(query.event);
  const viewer = await resolveStaffHealthViewer();
  if (!viewer) {
    return <AccessRestricted title="Health information is restricted" detail="Ask a system administrator if you need health information access for this event." />;
  }
  const sheet = query.sheet === "1";
  let data;
  try {
    data = await loadEventHealth(viewer, event.id, { organizationId: query.club || undefined, purpose: sheet ? "EXPORT" : "VIEW" });
  } catch (error) {
    if (error instanceof HealthViewError) return <AccessRestricted title="Health information is unavailable" detail={error.message} />;
    throw error;
  }
  const base = `/more/event-health?event=${encodeURIComponent(event.id)}`;
  return (
    <section className="page-stack">
      <BackLink href={`/more?event=${encodeURIComponent(event.id)}`} variant="staff">Back to More</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Confidential · read only</p>
          <h2>{data.event.name}: health information</h2>
          <p>Available through {data.event.availableThrough}, 30 days after the event ends. Every time this is opened or printed it is recorded.</p>
        </div>
        <div className="intro-actions">
          {sheet
            ? <PrintReportButton label="Print confidential sheet" />
            : <a className="secondary-button" href={`${base}${query.club ? `&club=${encodeURIComponent(query.club)}` : ""}&sheet=1`}>Open printable sheet</a>}
        </div>
      </div>
      <EventHealthSheet
        clubs={data.clubs}
        clubLinks={query.club ? undefined : (organizationId) => ({ view: `${base}&club=${encodeURIComponent(organizationId)}`, sheet: `${base}&club=${encodeURIComponent(organizationId)}&sheet=1` })}
      />
    </section>
  );
}
