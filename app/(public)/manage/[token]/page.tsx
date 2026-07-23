import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import {
  CalendarDays,
  CircleDollarSign,
  CircleHelp,
  Clock3,
  ExternalLink,
  LockKeyhole,
  MapPin,
  ReceiptText,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { PublicAttendeePasses } from "@/components/public-attendee-passes";
import { PublicRegistrationContactForm } from "@/components/public-registration-contact-form";
import { PublicSquarePayment } from "@/components/public-square-payment";
import { resolveRegistrationAccessToken } from "@/modules/public-access/repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Manage event registration",
  description: "View and update the contact details for a private IMSDA event registration.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

type PublicManagePageProps = {
  params: Promise<{ token: string }>;
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function money(cents: number) {
  return moneyFormatter.format(cents / 100);
}

function submittedLabel(
  submittedAt: string | null,
  timeZone: string,
) {
  if (!submittedAt) return "Not submitted";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(submittedAt));
}

function expiryLabel(expiresAt: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(expiresAt));
}

export default async function PublicManagePage({
  params,
}: PublicManagePageProps) {
  await connection();
  const { token } = await params;
  const view = await resolveRegistrationAccessToken(token);
  if (!view) notFound();
  const attendeePassesAvailable = (
    view.registration.status === "SUBMITTED"
    || view.registration.status === "CONFIRMED"
  ) && view.event.attendeePassesAvailable;

  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a
            className="public-registration-brand public-event-brand-link"
            href="https://imsda.org/"
          >
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          <span className="public-registration-secure">
            <LockKeyhole size={15} aria-hidden="true" />
            Private registration link
          </span>
        </div>
      </header>

      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow">Registration confirmation</p>
          <h1>{view.event.name}</h1>
          <p>
            Confirmation <strong>{view.registration.confirmationCode}</strong>
          </p>
        </div>
        <div className={`public-manage-status public-manage-status-${view.registration.statusTone}`}>
          <ShieldCheck size={22} aria-hidden="true" />
          <span>
            <small>Current status</small>
            <strong>{view.registration.statusLabel}</strong>
          </span>
        </div>
      </section>

      <div className="public-manage-layout">
        <div className="public-manage-main">
          <section className={`public-manage-status-card public-manage-tone-${view.registration.statusTone}`}>
            <span><ShieldCheck size={22} aria-hidden="true" /></span>
            <div>
              <p className="public-registration-eyebrow">Registration status</p>
              <h2>{view.registration.statusLabel}</h2>
              <p>{view.registration.statusDetail}</p>
            </div>
          </section>

          <section className="public-manage-card">
            <div className="public-manage-card-heading">
              <p className="public-registration-eyebrow">Event details</p>
              <h2>Your event at a glance</h2>
            </div>
            <dl className="public-manage-event-grid">
              <div>
                <dt><CalendarDays size={17} aria-hidden="true" /> Dates</dt>
                <dd>{view.event.dateLabel}</dd>
              </div>
              <div>
                <dt><Clock3 size={17} aria-hidden="true" /> Schedule</dt>
                <dd>{view.event.timeLabel}</dd>
              </div>
              <div>
                <dt><MapPin size={17} aria-hidden="true" /> Location</dt>
                <dd>{view.event.location ?? "Location details coming soon"}</dd>
              </div>
              <div>
                <dt><ReceiptText size={17} aria-hidden="true" /> Submitted</dt>
                <dd>{submittedLabel(view.registration.submittedAt, view.event.timezone)}</dd>
              </div>
            </dl>
            <a
              className="public-manage-inline-link"
              href={view.event.detailsUrl}
              rel="noreferrer"
            >
              View full event details <ExternalLink size={15} aria-hidden="true" />
            </a>
          </section>

          <section className="public-manage-card">
            <div className="public-manage-card-heading public-manage-heading-with-count">
              <div>
                <p className="public-registration-eyebrow">Attendee roster</p>
                <h2>People on this registration</h2>
              </div>
              <strong>{view.attendees.length}</strong>
            </div>
            {view.attendees.length > 0 ? (
              <ul className="public-manage-attendees">
                {view.attendees.map((attendee, index) => (
                  <li key={`${attendee.name}-${index}`}>
                    <span><UsersRound size={17} aria-hidden="true" /></span>
                    <div>
                      <small>Attendee {index + 1}</small>
                      <strong>{attendee.name}</strong>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="public-manage-empty">
                No attendee roster is recorded on this registration.
              </p>
            )}
            <div className="public-manage-readonly-note">
              Attendance, room or activity choices, and registration fees cannot
              be changed from this private page. Contact the event team for
              those changes.
            </div>
          </section>

          {attendeePassesAvailable && (
            <PublicAttendeePasses
              attendees={view.attendees}
              confirmationCode={view.registration.confirmationCode}
              token={token}
            />
          )}

          <section className="public-manage-card public-manage-payment-card">
            <div className="public-manage-card-heading">
              <p className="public-registration-eyebrow">Payment summary</p>
              <h2>{view.payment.label}</h2>
              <p>{view.payment.detail}</p>
            </div>
            {view.order && view.order.discountAmountCents > 0 && (
              <div className="public-manage-order-breakdown">
                <p className="public-registration-eyebrow">Saved order</p>
                {view.order.lineItems.map((item, index) => (
                  <div key={`${item.label}-${index}`}>
                    <span>{item.label}{item.pricingLabel && <small>{item.pricingLabel}</small>}</span>
                    <strong>{money(item.amountCents)}</strong>
                  </div>
                ))}
                <div>
                  <span>Subtotal</span>
                  <strong>{money(view.order.preDiscountSubtotalCents)}</strong>
                </div>
                <div className="is-discount">
                  <span>Promo code {view.order.promoCode}</span>
                  <strong>−{money(view.order.discountAmountCents)}</strong>
                </div>
                <div>
                  <span>Discounted subtotal</span>
                  <strong>{money(view.order.subtotalCents)}</strong>
                </div>
                {view.order.processingFeeCents > 0 && (
                  <div>
                    <span>Card processing</span>
                    <strong>{money(view.order.processingFeeCents)}</strong>
                  </div>
                )}
              </div>
            )}
            <dl className="public-manage-payment-grid">
              <div>
                <dt>Registration total</dt>
                <dd>{money(view.payment.totalCents)}</dd>
              </div>
              <div>
                <dt>Successful payments, net of refunds</dt>
                <dd>{money(view.payment.paidCents)}</dd>
              </div>
              {view.payment.refundedCents > 0 && (
                <div>
                  <dt>Refunds recorded</dt>
                  <dd>{money(view.payment.refundedCents)}</dd>
                </div>
              )}
              <div className="is-due">
                <dt>Amount due now</dt>
                <dd>{money(view.payment.amountDueCents)}</dd>
              </div>
            </dl>
            <PublicSquarePayment token={token} />
          </section>
        </div>

        <aside className="public-manage-side">
          <PublicRegistrationContactForm
            initialContact={view.contact}
            token={token}
          />

          <section className="public-manage-help-card">
            <span><CircleHelp size={23} aria-hidden="true" /></span>
            <p className="public-registration-eyebrow">Need a different change?</p>
            <h2>Contact the event team</h2>
            <p>
              The event team can help with cancellations, attendee changes,
              selections, payment questions, and refunds.
            </p>
            {view.event.supportContact && (
              <strong>{view.event.supportContact}</strong>
            )}
            <a href={view.event.supportUrl} rel="noreferrer">
              Contact IMSDA <ExternalLink size={15} aria-hidden="true" />
            </a>
          </section>

          <section className="public-manage-security-note">
            <CircleDollarSign size={20} aria-hidden="true" />
            <div>
              <strong>Keep this link private</strong>
              <p>
                Anyone with this link can view this registration and update its
                contact details. It expires {expiryLabel(view.access.expiresAt)}.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
