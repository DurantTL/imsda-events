import { BrandMark } from "@/components/brand-mark";

export default function PublicEventLoading() {
  return (
    <main className="public-registration-page public-event-page" aria-busy="true">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <div className="public-registration-brand">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </div>
        </div>
      </header>
      <section className="public-registration-loading" role="status" aria-live="polite">
        <span className="public-registration-loading-mark"><BrandMark /></span>
        <h1>Loading event details…</h1>
        <p>We’re checking registration dates, availability, and published forms.</p>
      </section>
    </main>
  );
}
