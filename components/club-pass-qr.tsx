/**
 * The club's own check-in QR (Q1, #412): one image staff can scan to open
 * the club's check-in view directly, without a scanned person. Shared here
 * so the director's club event page and the future club packet (#411) both
 * render it the same authorized-server-side way an attendee pass QR is
 * served — this file has no logic of its own to duplicate or drift.
 */
export function ClubPassQr({
  organizationId,
  eventId,
  size = 220,
}: {
  organizationId: string;
  eventId: string;
  size?: number;
}) {
  return (
    // Private, no-store dynamic image; the response explicitly disables caching.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt="Club check-in QR pass"
      height={size}
      loading="lazy"
      src={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/club-pass/qr`}
      width={size}
    />
  );
}
