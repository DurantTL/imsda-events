import { CreditCard } from "lucide-react";
import { formatCents, inPersonCardQuote } from "@/modules/payments/in-person-card";

/**
 * Shown at check-in when a registration still owes money. Staff take card
 * payments in the Square app on their phones, so this gives them the exact
 * amount to key in (balance plus Square's in-person fee) and the code to type
 * into the Square note so finance can attach the payment afterwards.
 */
export function CheckInPaymentDue({
  balanceCents,
  confirmationCode,
  partySize,
}: {
  balanceCents: number;
  confirmationCode: string;
  partySize: number;
}) {
  const quote = inPersonCardQuote(balanceCents);
  if (!quote) return null;
  return (
    <span className="checkin-payment-due" role="note">
      <CreditCard aria-hidden="true" size={14} />
      <span>
        <b>
          {formatCents(quote.balanceCents)} due
          {partySize > 1 ? ` for all ${partySize} people on ${confirmationCode}` : ""}
        </b>
        {" · "}Card in Square app: <b>{formatCents(quote.cardTotalCents)}</b>
        {" "}(includes {formatCents(quote.cardFeeCents)} card fee)
        {" · "}Cash or check: {formatCents(quote.balanceCents)}
        {" · "}Square note: <b>{confirmationCode}</b>
      </span>
    </span>
  );
}
