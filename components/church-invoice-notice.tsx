import { PerPersonPriceNotice } from "@/components/per-person-price-notice";
import {
  CHURCH_INVOICE_TIMING,
  NO_PAYMENT_ONLINE,
  type ChurchInvoiceTerms,
} from "@/modules/club-registrations/church-invoice-terms";
import type { PerPersonPrice } from "@/modules/club-registrations/per-person-price";

/**
 * What a church-invoiced registration leads with (#743): the per-person rate
 * and its terms, built from the event's configured fee and dates, then that no
 * payment is collected here. When the fee is too varied to state in one line
 * (`terms` is null) the per-person notice from #621 stands in. No total is
 * shown: a church-billed registrant is never given a sum (#621).
 */
export function ChurchInvoiceNotice({
  terms,
  price,
  className,
}: {
  terms: ChurchInvoiceTerms | null;
  price: PerPersonPrice;
  className?: string;
}) {
  if (!terms) return <PerPersonPriceNotice price={price} className={className} />;
  return (
    <div className={`church-invoice-notice${className ? ` ${className}` : ""}`} data-testid="church-invoice-terms">
      <p className="church-invoice-rate"><strong translate="no">{terms.rateSentence}</strong></p>
      <p className="church-invoice-terms">
        No payment is collected with this form — your church will be invoiced after the event based on confirmed attendance.
      </p>
      <PerPersonPriceNotice
        price={{ ...price, registrationLines: price.registrationLines.filter((line) => line.label !== terms.feeLabel) }}
        showNotice={false}
      />
    </div>
  );
}

/** The review step's invoice facts: nothing due online, who is invoiced, and when. */
export function ChurchInvoiceReviewFacts({ recipient }: { recipient: string | null }) {
  return (
    <dl className="church-invoice-facts" data-testid="church-invoice-facts">
      <div><dt>Payment</dt><dd>{NO_PAYMENT_ONLINE}</dd></div>
      <div><dt>Invoice recipient</dt><dd translate="no">{recipient ?? "Your church"}</dd></div>
      <div><dt>Invoice timing</dt><dd>{CHURCH_INVOICE_TIMING}</dd></div>
    </dl>
  );
}
