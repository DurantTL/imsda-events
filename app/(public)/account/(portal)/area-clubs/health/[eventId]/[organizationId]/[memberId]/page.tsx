import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HealthRecordView, HealthStatusChip } from "@/components/health-record-view";
import { requireAreaCoordinatorHealthViewer } from "@/modules/health-records/access";
import { HealthRecordError } from "@/modules/health-records/errors";
import { healthRecordsEnabled } from "@/modules/health-records/flag";
import { viewHealthRecord } from "@/modules/health-records/repository";

export const metadata: Metadata = { title: "Health record", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * An event attendee's Health Record for an Area Coordinator (#611, director's
 * decision of 2026-10-01). Switched off, it is a 404. Otherwise it needs a
 * coordinator with a verified second step, a member registered for this
 * event, and an open event window; any miss is a 404. View only, audited.
 */
export default async function AreaCoordinatorHealthPage({
  params,
}: {
  params: Promise<{ eventId: string; organizationId: string; memberId: string }>;
}) {
  if (!healthRecordsEnabled()) notFound();
  const { eventId, organizationId, memberId } = await params;
  const viewer = await requireAreaCoordinatorHealthViewer().catch((error: unknown) => {
    if (error instanceof HealthRecordError && error.code === "FORBIDDEN") return error;
    if (error instanceof HealthRecordError) notFound();
    throw error;
  });
  // Second step too old: say so (it is the coordinator's own session, nothing about a record).
  if (viewer instanceof HealthRecordError) {
    return <p className="public-manage-empty">{viewer.message} <a href="/account/two-step">Confirm now</a></p>;
  }
  const health = await viewHealthRecord(viewer, organizationId, memberId, new Date(), { eventId }).catch((error: unknown) => {
    if (error instanceof HealthRecordError) notFound();
    throw error;
  });
  return (
    <section className="page-stack club-form-page">
      <header>
        <h2 translate="no">Health record: {`${health.member.firstName} ${health.member.lastName}`.trim()}</h2>
        <p translate="no">{health.club.name}</p>
        <p><HealthStatusChip status={health.status} /></p>
        <p className="quiet-copy">View only, for this event. Opening this page is recorded.</p>
      </header>
      <HealthRecordView health={health} />
    </section>
  );
}
