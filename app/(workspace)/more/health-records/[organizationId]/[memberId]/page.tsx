import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { HealthRecordView, HealthStatusChip } from "@/components/health-record-view";
import { requireStaffHealthViewer } from "@/modules/health-records/access";
import { HealthRecordError } from "@/modules/health-records/errors";
import { healthRecordsEnabled } from "@/modules/health-records/flag";
import { viewHealthRecord } from "@/modules/health-records/repository";

export const metadata: Metadata = { title: "Health record", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * A member's Health Record for a system administrator, or for staff holding
 * VIEW_HEALTH_INFORMATION on an event (`?event=` names it; the member must be
 * an attendee of that event, inside its window) (#611): view only, and every
 * view is audited. With the feature off the page does not exist; without the
 * permission it says so and loads nothing.
 */
export default async function StaffHealthRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; memberId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  if (!healthRecordsEnabled()) notFound();
  const [{ organizationId, memberId }, { event }] = await Promise.all([params, searchParams]);
  const viewer = await requireStaffHealthViewer().catch((error: unknown) => {
    if (error instanceof HealthRecordError && error.code === "NOT_FOUND") notFound();
    if (error instanceof HealthRecordError && error.code === "FORBIDDEN") return null;
    if (error instanceof Error && error.name === "AccessDeniedError") return null;
    throw error;
  });
  if (!viewer) {
    return <AccessRestricted detail="Health records need the health information permission, granted by a system administrator." title="Health records are restricted" />;
  }
  const health = await viewHealthRecord(viewer, organizationId, memberId, new Date(), { eventId: event }).catch((error: unknown) => {
    if (error instanceof HealthRecordError) notFound();
    throw error;
  });
  return (
    <section className="page-stack club-form-page">
      <header>
        <h2 translate="no">Health record: {`${health.member.firstName} ${health.member.lastName}`.trim()}</h2>
        <p translate="no">{health.club.name}</p>
        <p><HealthStatusChip status={health.status} /></p>
        <p className="quiet-copy">View only. Opening this page is recorded.</p>
      </header>
      <HealthRecordView health={health} />
    </section>
  );
}
