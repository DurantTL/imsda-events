import { ArrowLeft, CircleAlert } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

/**
 * Branded "event not found" page for /register/<slug> when no published event
 * has that slug (#569). It names the slug so a mistyped link is easy to spot.
 */
export function PublicEventSlugNotFound({ slug }: { slug: string }) {
  return (
    <main className="public-registration-page public-event-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
        </div>
      </header>
      <section className="public-registration-not-found">
        <span><CircleAlert size={32} aria-hidden="true" /></span>
        <p className="public-registration-eyebrow">Event not found</p>
        <h1>We couldn&apos;t find an event called &ldquo;{slug}&rdquo;</h1>
        <p>The link may be mistyped or out of date, or registration for this event may not be available yet. Check the link you were given, or browse the list of events.</p>
        <a className="public-event-not-found-link" href="https://imsda.org/events/">
          <ArrowLeft size={16} aria-hidden="true" /> Browse events on imsda.org
        </a>
      </section>
    </main>
  );
}
