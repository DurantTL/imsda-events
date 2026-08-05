import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  ArrowRight,
  CircleDollarSign,
  CircleHelp,
  Inbox,
  MapPin,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { AttendeeAuthReturn } from "@/components/attendee-sign-in-form";
import { AttendeeProfileForm } from "@/components/attendee-profile-form";
import { AttendeeRegistrationContactForm } from "@/components/attendee-registration-contact-form";
import { AttendeeRegistrationAnswersForm } from "@/components/attendee-registration-answers-form";
import { MfaManager } from "@/components/mfa-manager";
import { PublicSquarePayment } from "@/components/public-square-payment";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { getAttendeeProfile } from "@/modules/attendee-accounts/profile-service";
import {
  listRegistrationsForVerifiedEmail,
  type AttendeeRegistrationSummary,
} from "@/modules/attendee-accounts/registrations-repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your registrations",
  description: "Every IMSDA event registration made with your email address.",
  robots: { index: false, follow: false, nocache: true },
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function money(cents: number) {
  return moneyFormatter.format(cents / 100);
}

function dateLabel(startsAt: string, endsAt: string, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const start = formatter.format(new Date(startsAt));
  const end = formatter.format(new Date(endsAt));
  return start === end ? start : `${start} – ${end}`;
}

function RegistrationCard({
  registration,
  editable,
}: {
  registration: AttendeeRegistrationSummary;
  editable: boolean;
}) {
  return (
    <section className="public-manage-card attendee-registration-card">
      <div className="public-manage-card-heading attendee-registration-heading">
        <div>
          <p className="public-registration-eyebrow">{registration.event.name}</p>
          <h2>Confirmation {registration.confirmationCode}</h2>
        </div>
        <span className={`attendee-status-pill attendee-status-pill-${registration.status.tone}`}>
          <ShieldCheck size={15} aria-hidden="true" />
          {registration.status.label}
        </span>
      </div>

      <dl className="public-manage-event-grid">
        <div>
          <dt><CalendarDays size={17} aria-hidden="true" /> Dates</dt>
          <dd>
            {dateLabel(
              registration.event.startsAt,
              registration.event.endsAt,
              registration.event.timezone,
            )}
          </dd>
        </div>
        <div>
          <dt><MapPin size={17} aria-hidden="true" /> Location</dt>
          <dd>{registration.event.location ?? "Location details coming soon"}</dd>
        </div>
        <div>
          <dt><UsersRound size={17} aria-hidden="true" /> Attendees</dt>
          <dd>
            {registration.attendeeNames.length > 0
              ? registration.attendeeNames.join(", ")
              : "No attendees recorded"}
          </dd>
        </div>
        <div>
          <dt><CircleDollarSign size={17} aria-hidden="true" /> Balance</dt>
          <dd>
            {registration.balanceCents > 0
              ? `${money(registration.balanceCents)} due of ${money(registration.totalCents)}`
              : `Paid in full · ${money(registration.totalCents)}`}
          </dd>
        </div>
      </dl>

      <p className="public-manage-readonly-note">
        {registration.status.detail}
      </p>
      <Link
        className="secondary-button attendee-hub-link"
        href={`/account/events/${encodeURIComponent(registration.event.slug)}`}
      >
        Open attendee hub <ArrowRight size={16} aria-hidden="true" />
      </Link>
      {editable && registration.balanceCents > 0 && (
        <PublicSquarePayment
          manageEndpoint={`/api/attendee/registrations/${encodeURIComponent(registration.id)}`}
        />
      )}
      {editable && (
        <AttendeeRegistrationContactForm
          registrationId={registration.id}
          initialContact={registration.contact}
        />
      )}
      {registration.answerEditing.fields.length > 0 && (
        <AttendeeRegistrationAnswersForm
          registrationId={registration.id}
          description={registration.answerEditing.reason}
          readOnly={!editable || !registration.answerEditing.enabled}
          initialExpectedUpdatedAt={registration.answerEditing.expectedUpdatedAt}
          fields={registration.answerEditing.fields}
          initialAttendees={registration.answerEditing.attendees}
        />
      )}
    </section>
  );
}

export default async function AttendeeAccountPage() {
  const [{ account, via }, staffSession] = await Promise.all([
    getCurrentAttendee(),
    getCurrentSession(),
  ]);
  if (!account) redirect("/account/sign-in");

  const registrations = await listRegistrationsForVerifiedEmail(account.verifiedEmail);
  const mfaStatus = await getAttendeeMfaStatus(account.id);
  const profile = await getAttendeeProfile(account.id);

  return (
    <main className="public-registration-page public-manage-page">
      <AttendeeAuthReturn />
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a
            className="public-registration-brand public-event-brand-link"
            href="https://imsda.org/"
          >
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          {staffSession.user
            ? <Link className="text-button" href="/overview">Back to staff workspace</Link>
            : <AttendeeSignOutButton />}
        </div>
      </header>

      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow">Your registrations</p>
          <h1>Hello, {account.displayName}</h1>
          <p>
            Everything registered with <strong>{account.verifiedEmail}</strong>
          </p>
        </div>
      </section>

      <div className="public-manage-layout">
        <div className="public-manage-main">
          {via === "attendee" && <AttendeeProfileForm initialProfile={profile} />}
          {registrations.length > 0
            ? registrations.map((registration) => (
              <RegistrationCard
                key={registration.id}
                registration={registration}
                editable={via === "attendee"}
              />
            ))
            : (
              <section className="public-manage-card">
                <div className="public-manage-card-heading">
                  <p className="public-registration-eyebrow">Nothing here yet</p>
                  <h2>No registrations match this address</h2>
                </div>
                <p className="public-manage-empty">
                  <Inbox size={17} aria-hidden="true" /> A registration appears here when its
                  contact email is {account.verifiedEmail}. If you registered under a different
                  address, the event team can correct the one on file — and doing that is what
                  attaches it to this account.
                </p>
              </section>
            )}
        </div>

        <aside className="public-manage-side">
          {/* Icon then a single block: this card is a flex row, and two loose
            * paragraphs would sit side by side rather than stack. */}
          <section className="public-manage-security-note">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>Why these and no others</strong>
              <p>
                This account reaches every registration whose contact email is your verified
                address, and nothing else. It is never matched on your name.
              </p>
            </div>
          </section>
          <section className="public-manage-help-card">
            <span><CircleHelp size={23} aria-hidden="true" /></span>
            <p className="public-registration-eyebrow">Need to change something?</p>
            <h2>Contact the event team</h2>
            <p>
              Contact details can be updated with a fresh emailed code. Changes to attendance,
              rooms, activities, cancellations, or transfers still go through the event team.
            </p>
          </section>
          <MfaManager
            initialStatus={mfaStatus}
            endpoint="/api/attendee/mfa"
            attendee
          />
        </aside>
      </div>
    </main>
  );
}
