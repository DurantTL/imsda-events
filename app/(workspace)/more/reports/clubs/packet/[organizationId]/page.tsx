import type { Metadata } from "next";
import Link from "next/link";
import { AccessRestricted } from "@/components/access-restricted";
import { ClubPacketSheet } from "@/components/club-packet-sheet";
import { PrintReportButton } from "@/components/print-report-button";
import { getClubPacketData } from "@/modules/reporting/club-packet-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";

export const metadata: Metadata = { title: "Club packet" };
export const dynamic = "force-dynamic";

/** Staff's printable club packet (Q1, #411): one club, gated the same as the four Camporee reports. */
export default async function StaffClubPacketPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { organizationId } = await params;
  const { event: requested } = await searchParams;
  const { event, allowed } = await resolveClubReportsAccess(requested);
  if (!allowed) {
    return (
      <AccessRestricted
        title="Club packets are restricted"
        detail="Ask an event administrator for report access, or for Pathfinder event-manager oversight of this club event."
      />
    );
  }
  const packet = await getClubPacketData(event.id, organizationId);
  if (!packet) {
    return <AccessRestricted title="No active registration" detail="This club has no submitted or confirmed registration for this event." />;
  }
  const eventQuery = `event=${encodeURIComponent(event.id)}`;

  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <p className="eyebrow">Event-day preparation</p>
          <h2>{packet.club.organizationName} packet</h2>
          <p>One letter sheet, printed double-sided: registration and roster on side 1, camping and assignments on side 2.</p>
        </div>
        <div className="intro-actions">
          <Link className="secondary-button" href={`/more/reports/clubs?${eventQuery}`}>Back to club reports</Link>
          <PrintReportButton label="Print this packet" />
        </div>
      </div>
      <ClubPacketSheet packet={packet} qrSrc={`/api/events/${encodeURIComponent(event.id)}/clubs/${encodeURIComponent(organizationId)}/club-pass/qr`} />
    </section>
  );
}
