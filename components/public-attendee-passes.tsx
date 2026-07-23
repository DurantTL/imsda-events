import { KeyRound, QrCode, ShieldCheck } from "lucide-react";

type PublicAttendeePassesProps = {
  token: string;
  confirmationCode: string;
  attendees: Array<{ id: string; name: string }>;
};

export function PublicAttendeePasses({
  token,
  confirmationCode,
  attendees,
}: PublicAttendeePassesProps) {
  if (attendees.length === 0) return null;

  return (
    <section className="public-manage-card public-attendee-pass-section">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Event-day arrival</p>
        <h2>Your attendee passes</h2>
        <p>
          Show the matching QR pass to event staff. Staff will review the
          attendee before confirming check-in.
        </p>
      </div>

      <div className="public-attendee-pass-grid">
        {attendees.map((attendee, index) => {
          const qrPath = `/api/public/manage/${encodeURIComponent(token)}/attendee-passes/${encodeURIComponent(attendee.id)}/qr`;
          const descriptionId = `attendee-pass-description-${index}`;
          return (
            <article className="public-attendee-pass" key={attendee.id}>
              <div className="public-attendee-pass-heading">
                <span><QrCode size={19} aria-hidden="true" /></span>
                <div>
                  <small>Attendee {index + 1}</small>
                  <strong>{attendee.name}</strong>
                </div>
              </div>
              {/* Private, dynamic QR images must bypass the optimizing image cache. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={`QR event pass for ${attendee.name}`}
                aria-describedby={descriptionId}
                height={280}
                loading="lazy"
                src={qrPath}
                width={280}
              />
              <p id={descriptionId}>
                <ShieldCheck size={15} aria-hidden="true" />
                This signed QR contains no name, email, phone number, or payment
                details.
              </p>
            </article>
          );
        })}
      </div>

      <div className="public-attendee-pass-fallback">
        <KeyRound size={18} aria-hidden="true" />
        <div>
          <strong>QR unavailable?</strong>
          <p>
            Staff can find everyone on this registration with confirmation code{" "}
            <span>{confirmationCode}</span>.
          </p>
        </div>
      </div>
    </section>
  );
}

