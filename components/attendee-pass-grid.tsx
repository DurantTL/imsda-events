import { ArrowRightLeft, QrCode } from "lucide-react";

type PassAttendee = { id: string; name: string };

/**
 * QR passes are minted only for the attendee's own session; the route refuses
 * staff "act as" (#744), so a staff viewer gets a switch prompt, not broken images.
 */
export function AttendeePassGrid({
  registrationId,
  attendees,
  via,
}: {
  registrationId: string;
  attendees: PassAttendee[];
  via: "attendee" | "staff" | null;
}) {
  if (via !== "attendee") {
    return (
      <div className="public-attendee-pass-switch">
        <p>Switch to your attendee account to show passes.</p>
        <form action="/api/auth/switch-to-attendee" method="post">
          <button className="text-button" type="submit">
            <ArrowRightLeft size={15} aria-hidden="true" /> Switch to my attendee account
          </button>
        </form>
      </div>
    );
  }
  return (
    <div className="public-attendee-pass-grid">
      {attendees.map((attendee) => (
        <article className="public-attendee-pass" key={attendee.id}>
          <div className="public-attendee-pass-heading">
            <span><QrCode size={19} aria-hidden="true" /></span>
            <strong translate="no">{attendee.name}</strong>
          </div>
          {/* Private dynamic image; the response explicitly disables caching. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`QR event pass for ${attendee.name}`}
            height={280}
            loading="lazy"
            src={`/api/attendee/registrations/${encodeURIComponent(registrationId)}/attendee-passes/${encodeURIComponent(attendee.id)}/qr`}
            width={280}
          />
        </article>
      ))}
    </div>
  );
}
