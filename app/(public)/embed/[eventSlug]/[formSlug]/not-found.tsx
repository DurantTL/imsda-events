import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

export default function EmbeddedRegistrationNotFound() {
  return (
    <main className="public-registration-embed-state">
      <BrandMark />
      <p className="public-registration-eyebrow">IMSDA Events</p>
      <h1>Registration form unavailable</h1>
      <p>This form may have moved or may not be published yet.</p>
      <Link className="primary-button" href="https://imsda.org/events/" target="_top">
        Browse IMSDA events
      </Link>
    </main>
  );
}
