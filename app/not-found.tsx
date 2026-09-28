import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, CircleAlert } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Site-wide branded 404 (#470). Next.js renders this for any route that
 * doesn't match a page, so no public path falls through to the framework's
 * bare 404.
 */
export default function NotFound() {
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
        <p className="public-registration-eyebrow">Page not found</p>
        <h1>We couldn&apos;t find that page</h1>
        <p>The link may be out of date, or the address may have been typed incorrectly.</p>
        <div className="public-not-found-links">
          <Link className="public-event-not-found-link" href="/">Events home</Link>
          <Link className="public-event-not-found-link" href="/calendar">
            <CalendarDays size={16} aria-hidden="true" /> See the calendar
          </Link>
        </div>
      </section>
    </main>
  );
}
