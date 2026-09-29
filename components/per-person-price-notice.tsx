import { formatPerPersonAmount, type PerPersonPrice } from "@/modules/club-registrations/per-person-price";

/**
 * The per-person price notice shown instead of any total on a church-billed
 * event (#621). Attendee lines appear only when attendees' prices differ, and
 * they are never summed.
 */
export function PerPersonPriceNotice({ price, className }: { price: PerPersonPrice; className?: string }) {
  return (
    <div className={className} data-testid="per-person-price">
      <p><strong translate="no">{price.notice}</strong></p>
      {price.attendeeLines.length > 0 && (
        <ul>
          {price.attendeeLines.map((line, index) => (
            <li key={`${line.attendeeLabel}-${index}`}>
              {line.attendeeLabel}: <span translate="no">{formatPerPersonAmount(line.amountCents)}</span> per person
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
