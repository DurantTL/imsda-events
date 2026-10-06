import type { Metadata } from "next";
import Link from "next/link";
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
import { RegistrationAccountPrompt } from "@/components/registration-account-prompt";
import { PublicAttendeePasses } from "@/components/public-attendee-passes";
import { PublicRegistrationContactForm } from "@/components/public-registration-contact-form";
import { PublicShirtSizeConfirmation } from "@/components/public-shirt-size-confirmation";
import { AttendeeRegistrationAnswersForm } from "@/components/attendee-registration-answers-form";
import { PublicSquarePayment } from "@/components/public-square-payment";
import { PerPersonPriceNotice } from "@/components/per-person-price-notice";
import { ClubClassPicker } from "@/components/club-class-picker";
import { GroupRegistrationEditor } from "@/components/group-registration-editor";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { getGroupRegistrationWorkspace } from "@/modules/group-registrations/repository";
import { authorizeRegistrationAccessToken, resolveRegistrationAccessToken } from "@/modules/public-access/repository";
import { getRegistrationResponsibleAdultView } from "@/modules/guardian-authority/repository";
import { PublicResponsibleAdult } from "@/components/public-responsible-adult";
import { PublicLodgingPreferences } from "@/components/public-lodging-preferences";
import { getRegistrantLodgingView } from "@/modules/lodging/preferences-service";

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
  // A "Group" registration (#650) can be reopened by its contact from this page.
  const group = view.isGroup ? await getGroupRegistrationWorkspace(token) : null;
  // Minors on this registration and who is responsible for them (#131): the registrant can change it here.
  const responsibleAdultAccess = !view.isGroup && (
    view.registration.status === "SUBMITTED"
    || view.registration.status === "CONFIRMED"
    || view.registration.status === "WAITLISTED"
  ) ? await authorizeRegistrationAccessToken(token) : null;
  const responsibleAdults = responsibleAdultAccess ? await getRegistrationResponsibleAdultView(responsibleAdultAccess.registrationId) : null;
  // Lodging preferences (#199): only where the event collects them, for an active individual registration.
  const lodging = responsibleAdultAccess && (view.registration.status === "SUBMITTED" || view.registration.status === "CONFIRMED")
    ? await getRegistrantLodgingView({ eventId: responsibleAdultAccess.eventId, registrationId: responsibleAdultAccess.registrationId })
    : null;
  const attendeePassesAvailable = (
    view.registration.status === "SUBMITTED"
    || view.registration.status === "CONFIRMED"
  ) && view.event.attendeePassesAvailable;

  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link
            className="public-registration-brand public-event-brand-link"
            href="/"
          >
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
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
            Confirmation <strong translate="no">{view.registration.confirmationCode}</strong>
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
            {view.event.detailsUrl && (
              <a
                className="public-manage-inline-link"
                href={view.event.detailsUrl}
                rel="noreferrer"
              >
                View full event details <ExternalLink size={15} aria-hidden="true" />
              </a>
            )}
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
                      <strong translate="no">{attendee.name}</strong>
                      {view.event.shirtSizesAvailable && (
                        <em>
                          Shirt: {attendee.shirtSize ?? "not selected"}
                        </em>
                      )}
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
              {view.event.shirtSizesAvailable && (
                <>Shirt sizes can be reconfirmed below. </>
              )}
              {view.answerEditing.enabled
                ? "Eligible session and retreat choices can be updated below. "
                : ""}
              Attendance, priced or capacity-controlled choices, identity,
              protected details, and registration fees remain staff-managed.
            </div>
          </section>

          {group && (
            <section className="public-manage-card" aria-labelledby="group-registration-title">
              <div className="public-manage-card-heading">
                <p className="public-registration-eyebrow">Group registration</p>
                <h2 id="group-registration-title">Your group</h2>
              </div>
              <dl className="public-manage-event-grid">
                {group.registration.location && (
                  <div>
                    <dt><MapPin size={17} aria-hidden="true" /> Registered at</dt>
                    <dd translate="no">{group.registration.location.name}</dd>
                  </div>
                )}
                <div>
                  <dt><CircleDollarSign size={17} aria-hidden="true" /> Estimated total</dt>
                  <dd translate="no">{money(group.billing.estimate.totalCents)}</dd>
                </div>
              </dl>
              <p>
                <strong>{group.billing.notice}</strong> No payment is due online. The total is an estimate from
                the price of each person{group.billing.estimate.perPersonCents !== null ? ` (${money(group.billing.estimate.perPersonCents)} each)` : ""}.
              </p>
              {group.event.registrationClosesOn && group.event.edit.open && (
                <p className="field-help">You can change people, locations, and classes until registration closes on {formatCalendarDate(group.event.registrationClosesOn)}.</p>
              )}
              {group.experience && (
                <GroupRegistrationEditor token={token} workspace={{ ...group, experience: group.experience }} />
              )}
              {!group.experience && <p className="field-help">This registration can&apos;t be edited here right now. Contact the event team.</p>}
            </section>
          )}

          {group?.classes && group.classes.offerings.length > 0 && (
            <ClubClassPicker
              endpoint={`/api/public/manage/${encodeURIComponent(token)}/group/classes`}
              initialWorkspace={group.classes}
              noun="group"
            />
          )}

          {view.event.shirtSizesAvailable && view.attendees.length > 0 && (
            view.registration.status === "SUBMITTED"
            || view.registration.status === "CONFIRMED"
            || view.registration.status === "WAITLISTED"
          ) && (
            <PublicShirtSizeConfirmation
              attendees={view.attendees}
              token={token}
            />
          )}

          {lodging?.enabled && <PublicLodgingPreferences token={token} initialView={lodging} />}

          {responsibleAdults && <PublicResponsibleAdult token={token} view={responsibleAdults} readOnly={responsibleAdultAccess?.attendeeEditPolicy === "VERIFY_EVERY_EDIT"} />}

          {view.answerEditing.fields.length > 0 && (
            <section className="public-manage-card">
              <AttendeeRegistrationAnswersForm
                answerEndpoint={`/api/public/manage/${encodeURIComponent(token)}/answers`}
                description={view.answerEditing.reason}
                readOnly={!view.answerEditing.enabled}
                fields={view.answerEditing.fields}
                initialAttendees={view.answerEditing.attendees}
                initialExpectedUpdatedAt={view.answerEditing.expectedUpdatedAt}
              />
            </section>
          )}

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
            {view.perPerson && <PerPersonPriceNotice price={view.perPerson} className="public-manage-order-breakdown" />}
            {view.order && view.order.discountAmountCents > 0 && (
              <div className="public-manage-order-breakdown">
                <p className="public-registration-eyebrow">Saved order</p>
                {view.order.lineItems.map((item, index) => (
                  <div key={`${item.label}-${index}`}>
                    <span>{item.label}{item.pricingLabel && <small>{item.pricingLabel}</small>}</span>
                    <strong translate="no">{money(item.amountCents)}</strong>
                  </div>
                ))}
                <div>
                  <span>Subtotal</span>
                  <strong translate="no">{money(view.order.preDiscountSubtotalCents)}</strong>
                </div>
                <div className="is-discount">
                  <span>Promo code <span translate="no">{view.order.promoCode}</span></span>
                  <strong translate="no">−{money(view.order.discountAmountCents)}</strong>
                </div>
                <div>
                  <span>Discounted subtotal</span>
                  <strong translate="no">{money(view.order.subtotalCents)}</strong>
                </div>
                {view.order.processingFeeCents > 0 && (
                  <div>
                    <span>Card processing</span>
                    <strong translate="no">{money(view.order.processingFeeCents)}</strong>
                  </div>
                )}
              </div>
            )}
            {view.payment.totalCents !== null && view.payment.paidCents !== null && view.payment.refundedCents !== null && view.payment.amountDueCents !== null && (
            <dl className="public-manage-payment-grid">
              <div>
                <dt>Registration total</dt>
                <dd translate="no">{money(view.payment.totalCents)}</dd>
              </div>
              <div>
                <dt>Successful payments, net of refunds</dt>
                <dd translate="no">{money(view.payment.paidCents)}</dd>
              </div>
              {view.payment.refundedCents > 0 && (
                <div>
                  <dt>Refunds recorded</dt>
                  <dd translate="no">{money(view.payment.refundedCents)}</dd>
                </div>
              )}
              <div className="is-due">
                <dt>Amount due now</dt>
                <dd translate="no">{money(view.payment.amountDueCents)}</dd>
              </div>
            </dl>
            )}
            {!view.perPerson && !view.isGroup && <PublicSquarePayment token={token} />}
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

          <RegistrationAccountPrompt
            email={view.contact.email}
            embedded={false}
            returnTo={`/manage/${token}`}
          />

          <section className="public-manage-security-note">
            <CircleDollarSign size={20} aria-hidden="true" />
            <div>
              <strong>Keep this link private</strong>
              <p>
                Anyone with this link can view this registration and update its
                contact details{group ? ", people, locations, and classes" : ""}. It expires {expiryLabel(view.access.expiresAt)}.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
