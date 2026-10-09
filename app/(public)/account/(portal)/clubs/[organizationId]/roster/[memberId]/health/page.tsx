import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { HealthRecordActions } from "@/components/health-record-actions";
import { HealthRecordForm } from "@/components/health-record-form";
import { HealthRecordView, HealthStatusChip } from "@/components/health-record-view";
import { getRosterAccessStateForPage, RosterAccessError } from "@/modules/club-rosters/access";
import { requireHealthViewerForClub } from "@/modules/health-records/access";
import { HealthRecordError } from "@/modules/health-records/errors";
import { healthRecordsEnabled } from "@/modules/health-records/flag";
import { listHealthRecordLinks, viewHealthRecord } from "@/modules/health-records/repository";

export const metadata: Metadata = { title: "Health record", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * The Health tab for one roster member (#611). With the feature switched off
 * this page does not exist. Otherwise only the club's own director or deputy
 * gets in, after the roster's second step; opening it is audited.
 */
export default async function ClubMemberHealthPage({ params }: { params: Promise<{ organizationId: string; memberId: string }> }) {
  if (!healthRecordsEnabled()) notFound();
  const { organizationId, memberId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const viewer = await requireHealthViewerForClub(organizationId).catch((error: unknown) => {
    if (error instanceof HealthRecordError && error.code === "FORBIDDEN") return null;
    if (error instanceof HealthRecordError || error instanceof RosterAccessError) notFound();
    throw error;
  });
  if (!viewer) {
    return <p className="public-manage-empty">Health records are kept by the club&apos;s director and deputy.</p>;
  }
  const health = await viewHealthRecord(viewer, organizationId, memberId).catch((error: unknown) => {
    if (error instanceof HealthRecordError) notFound();
    throw error;
  });
  const links = viewer.kind === "CLUB_LEADER" ? await listHealthRecordLinks(viewer, organizationId, memberId) : [];
  const memberName = `${health.member.firstName} ${health.member.lastName}`.trim();
  const rosterHref = `/account/clubs/${organizationId}/roster`;

  return (
    <section className="page-stack club-form-page">
      <BackLink href={rosterHref}>Back to roster</BackLink>
      <header>
        <h2 translate="no">Health record: {memberName}</h2>
        <p><HealthStatusChip status={health.status} /></p>
        <p className="quiet-copy">Opening this page is recorded. Health details are never emailed, exported, or printed in the check-in book.</p>
      </header>
      <HealthRecordView health={health} />
      {health.canEdit && (
        <>
          <HealthRecordActions canConfirm={health.status === "NEEDS_UPDATE"} links={links} memberId={memberId} organizationId={organizationId} />
          <details open={health.status === "NONE"}>
            <summary>{health.status === "NONE" ? "Enter the health record from the paper form" : "Edit this record"}</summary>
            <HealthRecordForm
              clubName={health.club.name}
              consentText={health.consentText}
              doneHref={`${rosterHref}/${encodeURIComponent(memberId)}/health`}
              initialValues={health.values}
              needsCorrection={health.needsCorrection}
              memberName={memberName}
              mode={{ kind: "director", organizationId, memberId }}
              sponsoringChurch={health.club.sponsoringChurch}
            />
          </details>
        </>
      )}
    </section>
  );
}
