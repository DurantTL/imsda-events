import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EventHealthSheet } from "@/components/event-health-sheet";
import { PrintReportButton } from "@/components/print-report-button";
import { clubLeaderHealthViewerFromAccess } from "@/modules/coordinator-health/access";
import { HealthViewError, listHealthEvents, loadEventHealth } from "@/modules/coordinator-health/repository";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Event health information", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * Your own club's health information for a club event (#658): dietary notes as
 * entered, the medical-need flag, and emergency contacts, for your club's
 * attendees only. Director and deputy only, past the roster's second step.
 * Opening it is audited as a view; `?sheet=1` is the printable sheet (an export).
 */
export default async function ClubHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ event?: string; sheet?: string }>;
}) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const viewer = clubLeaderHealthViewerFromAccess(access);
  if (!viewer) return <p className="public-manage-empty">Health information is kept by the club&apos;s director and deputy.</p>;
  const base = `/account/clubs/${organizationId}/health`;

  if (!query.event) {
    const events = await listHealthEvents(viewer);
    return (
      <>
        <p className="inline-notice" role="status">Confidential. Each event is available until 30 days after it ends, and every time you open or print one it is recorded.</p>
        {events.length === 0 ? <p className="quiet-copy">No event your club registered for is open for health information.</p> : (
          <ul className="account-overview-list">
            {events.map((event) => (
              <li key={event.id}>
                <a href={`${base}?event=${encodeURIComponent(event.id)}`}><strong>{event.name}</strong></a>
                <small> available through {event.availableThrough}</small>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  const sheet = query.sheet === "1";
  let data;
  try {
    data = await loadEventHealth(viewer, query.event, { purpose: sheet ? "EXPORT" : "VIEW" });
  } catch (error) {
    if (error instanceof HealthViewError) notFound();
    throw error;
  }
  return (
    <>
      <h2>{data.event.name}</h2>
      <p className="inline-notice" role="status">Your club only. Available through {data.event.availableThrough}. This view is recorded.</p>
      {sheet
        ? <PrintReportButton label="Print confidential sheet" />
        : <a className="secondary-button" href={`${base}?event=${encodeURIComponent(data.event.id)}&sheet=1`}>Open printable sheet</a>}
      <EventHealthSheet clubs={data.clubs} />
    </>
  );
}
