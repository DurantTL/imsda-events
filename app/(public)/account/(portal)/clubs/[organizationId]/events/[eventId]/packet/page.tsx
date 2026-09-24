import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ClubPacketSheet } from "@/components/club-packet-sheet";
import { PrintReportButton } from "@/components/print-report-button";
import { loadDirectorClubPacket } from "@/modules/reporting/director-club-packet";

export const metadata: Metadata = { title: "Club packet" };
export const dynamic = "force-dynamic";

/**
 * A director's own club packet (Q1, #411) — never any other club's, since
 * `loadDirectorClubPacket` re-checks this exact club's roster access itself.
 */
export default async function DirectorClubPacketPage({
  params,
}: {
  params: Promise<{ organizationId: string; eventId: string }>;
}) {
  const { organizationId, eventId } = await params;
  const packet = await loadDirectorClubPacket(organizationId, eventId);
  if (!packet) return null;

  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <Link className="text-button" href={`/account/clubs/${organizationId}/events/${eventId}`}>
            <ArrowLeft aria-hidden="true" size={14} /> Back to your event
          </Link>
          <h2>Your club packet</h2>
          <p>Print this for check-in: one letter sheet, printed double-sided.</p>
        </div>
        <PrintReportButton label="Print packet" />
      </div>
      <ClubPacketSheet packet={packet} qrSrc={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/club-pass/qr`} />
    </section>
  );
}
