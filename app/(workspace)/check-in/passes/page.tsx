import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, QrCode, ShieldCheck } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import {
  attendeePassExpiry,
  attendeePassIsAvailable,
} from "@/modules/checkin/attendee-pass-token";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";

export const metadata: Metadata = {
  title: "Printable attendee passes",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

function eventDateLabel(start: Date, end: Date, timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const startLabel = format.format(start);
  const endLabel = format.format(end);
  return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
}

export default async function PrintableAttendeePassesPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_CHECK_IN")) {
    return (
      <AccessRestricted
        title="Attendee passes are restricted"
        detail="Only event administrators and check-in staff can print attendee passes."
      />
    );
  }

  const registrations = await listRegistrations(event.id, {
    statuses: activeRegistrationStatuses,
  });
  const passes = registrations.flatMap((registration) => (
    registration.attendees.map((attendee) => ({
      attendeeId: attendee.id,
      attendeeType: attendee.attendeeType,
      confirmationCode: registration.confirmationCode,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
    }))
  )).sort((left, right) => (
    left.lastName.localeCompare(right.lastName)
    || left.firstName.localeCompare(right.firstName)
    || left.confirmationCode.localeCompare(right.confirmationCode)
  ));
  const expiry = attendeePassExpiry(event.endsAt);
  const passesAvailable = attendeePassIsAvailable(event.endsAt);
  const eventQuery = `?event=${encodeURIComponent(event.id)}`;

  return (
    <section className="page-stack printable-passes-workspace">
      <div className="page-intro printable-passes-intro">
        <div>
          <p className="eyebrow">Event-day preparation</p>
          <h2>Printable attendee passes</h2>
          <p>
            One signed check-in pass for every active attendee at {event.name}.
            Print the whole set, then hand each card to the matching attendee.
          </p>
        </div>
        <div className="intro-actions printable-pass-actions">
          <Link className="secondary-button" href={`/check-in${eventQuery}`}>
            Back to check-in
          </Link>
          {passes.length > 0 && passesAvailable && (
            <PrintReportButton label="Print attendee passes" />
          )}
        </div>
      </div>

      <div className="report-safety-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <p>
          <strong>Privacy-safe QR codes.</strong> Each code contains only signed,
          event-scoped identifiers and an expiration time—never a name, email,
          phone number, payment detail, or confirmation code. Staff still review
          the attendee before confirming check-in.
        </p>
      </div>

      {!passesAvailable && (
        <div className="inline-notice error" role="alert">
          These passes expired 48 hours after the event ended and cannot be
          printed again. Staff can still use the arrival roster for historical
          review.
        </div>
      )}

      {passesAvailable && passes.length > 0 && (
        <>
          <div className="printable-pass-summary">
            <strong>{passes.length} {passes.length === 1 ? "pass" : "passes"}</strong>
            <span>
              {eventDateLabel(event.startsAt, event.endsAt, event.timezone)}
              {event.location ? ` · ${event.location}` : ""}
            </span>
            <small>Valid through {expiry.toLocaleString("en-US", { timeZone: event.timezone })}</small>
          </div>
          <div className="printable-pass-grid">
            {passes.map((pass, index) => {
              const descriptionId = `staff-pass-description-${index}`;
              const qrPath = `/api/events/${encodeURIComponent(event.id)}/attendee-passes/${encodeURIComponent(pass.attendeeId)}/qr`;
              return (
                <article className="printable-pass-card" key={pass.attendeeId}>
                  <header>
                    <span><QrCode aria-hidden="true" size={20} /></span>
                    <div>
                      <small>{event.name}</small>
                      <strong>{pass.firstName} {pass.lastName}</strong>
                    </div>
                  </header>
                  {/* Private, dynamic QR images must bypass the optimizing image cache. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={`QR check-in pass for ${pass.firstName} ${pass.lastName}`}
                    aria-describedby={descriptionId}
                    height={280}
                    src={qrPath}
                    width={280}
                  />
                  <dl>
                    <div><dt>Confirmation</dt><dd>{pass.confirmationCode}</dd></div>
                    <div><dt>Attendee type</dt><dd>{pass.attendeeType.toLowerCase()}</dd></div>
                  </dl>
                  <p id={descriptionId}>
                    <KeyRound aria-hidden="true" size={14} />
                    Scan at check-in. Staff review is required.
                  </p>
                </article>
              );
            })}
          </div>
        </>
      )}

      {passesAvailable && passes.length === 0 && (
        <div className="empty-state panel">
          <QrCode aria-hidden="true" size={26} />
          <h3>No passes to print yet</h3>
          <p>Active submitted or confirmed attendees will appear here automatically.</p>
        </div>
      )}
    </section>
  );
}
