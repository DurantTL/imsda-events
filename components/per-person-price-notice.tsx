import { formatPerPersonAmount, registrationLineText, type PerPersonPrice } from "@/modules/club-registrations/per-person-price";

/**
 * The per-person price notice shown instead of any total on a church-billed
 * event (#621). Attendee lines appear only when attendees' prices differ,
 * registration-level lines are listed on their own, and nothing is summed.
 */
export function PerPersonPriceNotice({ price, className, showNotice = true }: { price: PerPersonPrice; className?: string; showNotice?: boolean }) {
  if (!showNotice && price.attendeeLines.length === 0 && price.registrationLines.length === 0) return null;
  return (
    <div className={className} data-testid="per-person-price">
      {showNotice && <p><strong translate="no">{price.notice}</strong></p>}
      {(price.attendeeLines.length > 0 || price.registrationLines.length > 0) && (
        <ul>
          {price.attendeeLines.map((line, index) => (
            <li key={`attendee-${index}`}>
              {line.attendeeLabel}: <span translate="no">{formatPerPersonAmount(line.amountCents)}</span> per person
            </li>
          ))}
          {price.registrationLines.map((line, index) => (
            <li key={`registration-${index}`} translate="no">{registrationLineText(price, line)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
