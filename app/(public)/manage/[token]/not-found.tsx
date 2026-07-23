import { ArrowLeft, Link2Off } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";

export default function PublicManageNotFound() {
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
        </div>
      </header>
      <section className="public-registration-not-found">
        <span><Link2Off size={32} aria-hidden="true" /></span>
        <p className="public-registration-eyebrow">Private link unavailable</p>
        <h1>This registration link is no longer active</h1>
        <p>
          The link may be incomplete, expired, or revoked. Use the link from
          your latest confirmation message or contact the event team for help.
        </p>
        <a
          className="public-event-not-found-link"
          href="https://imsda.org/contact/"
          rel="noreferrer"
        >
          <ArrowLeft size={16} aria-hidden="true" /> Contact IMSDA
        </a>
      </section>
    </main>
  );
}
