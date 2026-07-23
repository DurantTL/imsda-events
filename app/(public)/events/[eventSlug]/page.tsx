import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  CircleHelp,
  Clock3,
  ExternalLink,
  MapPin,
  Megaphone,
  UsersRound,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { getPublicEventLanding } from "@/modules/events/public-repository";

export const dynamic = "force-dynamic";

type PublicEventPageProps = {
  params: Promise<{ eventSlug: string }>;
};

export async function generateMetadata({
  params,
}: PublicEventPageProps): Promise<Metadata> {
  const { eventSlug } = await params;
  const landing = await getPublicEventLanding(eventSlug);
  if (!landing) {
    return {
      title: "Event registration unavailable",
      description: "This IMSDA event registration page is not available.",
      robots: { index: false, follow: false },
    };
  }

  const description = `View details and choose a registration form for ${landing.event.name}, ${landing.event.dateLabel}.`;
  return {
    title: `${landing.event.name} registration`,
    description,
    alternates: {
      canonical: `/events/${encodeURIComponent(eventSlug)}`,
    },
    robots: { index: true, follow: true },
    openGraph: {
      title: `${landing.event.name} registration`,
      description,
      type: "website",
      siteName: "IMSDA Events",
      url: `/events/${encodeURIComponent(eventSlug)}`,
    },
  };
}

export default async function PublicEventPage({
  params,
}: PublicEventPageProps) {
  const { eventSlug } = await params;
  const landing = await getPublicEventLanding(eventSlug);
  if (!landing) notFound();

  const hasForms = landing.forms.length > 0;
  const canChooseForm = landing.lifecycle.ctaEnabled && hasForms;

  return (
    <main className="public-registration-page public-event-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a className="public-registration-brand public-event-brand-link" href="https://imsda.org/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          <a className="public-event-details-link" href={landing.links.detailsUrl}>
            Back to full event details <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </header>

      <section className="public-registration-hero public-event-hero">
        <div>
          <p className="public-registration-eyebrow">Iowa-Missouri Conference event</p>
          <h1>{landing.event.name}</h1>
          <p>Everything you need to choose the right registration path.</p>
        </div>
        <div className="public-registration-event-details">
          <span><CalendarDays size={17} aria-hidden="true" /> {landing.event.dateLabel}</span>
          <span><Clock3 size={17} aria-hidden="true" /> {landing.event.timeLabel}</span>
          <span><MapPin size={17} aria-hidden="true" /> {landing.event.location ?? "Location details coming soon"}</span>
        </div>
      </section>

      {landing.announcements.length > 0 && (
        <section
          className="public-event-announcement-feed"
          aria-labelledby="public-event-updates-title"
        >
          <header className="public-event-announcement-heading">
            <span aria-hidden="true"><Megaphone size={20} /></span>
            <div>
              <p className="public-registration-eyebrow">Attendee feed</p>
              <h2 id="public-event-updates-title">Event updates</h2>
            </div>
          </header>
          <ul className="public-event-announcement-list">
            {landing.announcements.map((announcement, index) => {
              const headingId = `public-event-announcement-${index}`;
              return (
                <li key={`${announcement.publishedAt}:${announcement.title}:${index}`}>
                  <article
                    className={[
                      "public-event-announcement",
                      `is-${announcement.priority.toLowerCase()}`,
                      announcement.isFeatured ? "is-featured" : "",
                    ].filter(Boolean).join(" ")}
                    aria-labelledby={headingId}
                  >
                    <div className="public-event-announcement-meta">
                      <span className="public-event-announcement-priority">
                        {announcement.priorityLabel}
                      </span>
                      <span>{announcement.placementLabel}</span>
                      <time dateTime={announcement.publishedAt}>
                        Published {announcement.publishedLabel}
                      </time>
                    </div>
                    <h3 id={headingId}>{announcement.title}</h3>
                    <p>{announcement.body}</p>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="public-event-layout">
        <section className="public-event-main" aria-labelledby="registration-options-title">
          <div className="public-event-registration-state">
            <span className={`public-event-status is-${landing.lifecycle.state.toLowerCase()}`}>
              {landing.lifecycle.statusLabel}
            </span>
            <div>
              <p className="public-registration-eyebrow">Online registration</p>
              <h2 id="registration-options-title">Choose how you’re registering</h2>
              <p>{landing.lifecycle.detail}</p>
            </div>
          </div>

          {hasForms ? (
            <div className="public-event-form-list">
              {landing.forms.map((form, index) => (
                <article className="public-event-form-card" key={form.id}>
                  <div className="public-event-form-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <div className="public-event-form-copy">
                    <p className="public-registration-eyebrow">{form.audienceLabel}</p>
                    <h3>{form.title}</h3>
                    <p>{form.description}</p>
                    <ul aria-label={`${form.title} details`}>
                      {form.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
                    </ul>
                  </div>
                  {canChooseForm ? (
                    <Link className="public-event-form-cta" href={form.href}>
                      {landing.lifecycle.ctaLabel} <ArrowRight size={17} aria-hidden="true" />
                    </Link>
                  ) : (
                    <span className="public-event-form-cta is-disabled" aria-disabled="true">
                      {landing.lifecycle.ctaEnabled ? "Form unavailable" : landing.lifecycle.ctaLabel}
                    </span>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="public-event-empty-forms">
              <CalendarDays size={28} aria-hidden="true" />
              <h3>Registration forms are being prepared</h3>
              <p>Event details are available now. Please check back or contact the event team for registration help.</p>
            </div>
          )}
        </section>

        <aside className="public-event-sidebar" aria-label="Event registration help">
          <section className="public-event-info-card">
            <span className="public-event-side-icon"><UsersRound size={20} aria-hidden="true" /></span>
            <p className="public-registration-eyebrow">Current availability</p>
            <h2>{landing.lifecycle.statusLabel}</h2>
            {landing.lifecycle.remainingSpots === null ? (
              <p>No event-wide capacity limit is listed.</p>
            ) : landing.lifecycle.remainingSpots > 0 ? (
              <p><strong>{landing.lifecycle.remainingSpots}</strong> event spot{landing.lifecycle.remainingSpots === 1 ? "" : "s"} currently remain.</p>
            ) : (
              <p>The event-wide capacity has been reached.</p>
            )}
          </section>

          <section className="public-event-info-card public-event-help-card">
            <span className="public-event-side-icon purple"><CircleHelp size={20} aria-hidden="true" /></span>
            <p className="public-registration-eyebrow">Need help?</p>
            <h2>Contact the event team</h2>
            <p>Questions about lodging, accessibility, fees, or which form to use?</p>
            {landing.event.supportContact && (
              <strong className="public-event-support-contact">
                {landing.event.supportContact}
              </strong>
            )}
            <a href={landing.links.supportUrl}>
              Contact IMSDA <ExternalLink size={15} aria-hidden="true" />
            </a>
          </section>

          <a className="public-event-full-details-card" href={landing.links.detailsUrl}>
            <span>
              <small>Schedule, speakers, and full details</small>
              <strong>View on imsda.org</strong>
            </span>
            <ExternalLink size={18} aria-hidden="true" />
          </a>
        </aside>
      </div>
    </main>
  );
}
