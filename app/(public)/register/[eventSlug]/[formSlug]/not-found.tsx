import { CircleAlert } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";

export default function PublicRegistrationNotFound() {
  return (
    <main className="public-registration-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <div className="public-registration-brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div>
        </div>
      </header>
      <section className="public-registration-not-found">
        <span><CircleAlert size={32} aria-hidden="true" /></span>
        <p className="public-registration-eyebrow">Registration unavailable</p>
        <h1>This registration form is not open</h1>
        <p>The link may be incorrect, the form may not be published yet, or registration may have closed. Check the event link you received or contact the event organizer.</p>
      </section>
    </main>
  );
}
