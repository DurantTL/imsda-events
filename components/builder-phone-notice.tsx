import Link from "next/link";
import { Monitor } from "lucide-react";

/**
 * Shown instead of the registration form builder on phones (#685). The builder
 * itself stays in the DOM and is only hidden by CSS under 768px, so routes and
 * behavior are unchanged.
 */
export function BuilderPhoneNotice({
  eventId,
  builderName = "registration form builder",
  backHref,
  backLabel = "Back to Dashboard",
}: {
  eventId?: string;
  /** What the page is called in the notice, for builders other than the registration form builder (#712). */
  builderName?: string;
  backHref?: string;
  backLabel?: string;
}) {
  const href = backHref ?? `/overview?event=${encodeURIComponent(eventId ?? "")}`;
  return (
    <section className="panel builder-phone-notice" role="note" aria-labelledby="builder-phone-notice-title">
      <Monitor aria-hidden="true" size={28} />
      <h2 id="builder-phone-notice-title">Use a computer or tablet for this page</h2>
      <p>
        The {builderName} isn&apos;t built for phones. Changes may not work correctly here.
        Please open this page on a computer or tablet.
      </p>
      <Link className="primary-button" href={href}>{backLabel}</Link>
    </section>
  );
}
