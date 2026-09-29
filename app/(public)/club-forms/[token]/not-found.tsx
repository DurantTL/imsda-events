import { Link2Off } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

/** The one answer for every private form link that cannot be used (#610): nothing says why. */
export default function ClubFormLinkUnavailable() {
  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
        </div>
      </header>
      <section className="public-registration-not-found">
        <span><Link2Off size={32} aria-hidden="true" /></span>
        <p className="public-registration-eyebrow">Private link unavailable</p>
        <h1>This form link is no longer active</h1>
        <p>
          The link may have been used already, expired, or been withdrawn. Each link works once. Ask the club that
          sent it for a new one.
        </p>
      </section>
    </main>
  );
}
