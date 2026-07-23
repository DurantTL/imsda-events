import { BrandMark } from "@/components/brand-mark";

export default function PublicRegistrationLoading() {
  return (
    <main className="public-registration-page" aria-busy="true">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <div className="public-registration-brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div>
        </div>
      </header>
      <section className="public-registration-loading" role="status" aria-live="polite">
        <span className="public-registration-loading-mark"><BrandMark /></span>
        <h1>Loading event registration…</h1>
        <p>We’re checking the published form and current availability.</p>
      </section>
    </main>
  );
}
