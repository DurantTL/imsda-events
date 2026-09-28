function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export const REFUND_REASON_MIN_LENGTH = 3;
export const REFUND_REASON_MAX_LENGTH = 300;

/**
 * The same trimmed-length rule the refund route's schema applies, checked
 * before the confirm dialog opens — so "   " never reaches a review that the
 * server would then reject.
 */
export function refundReasonError(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < REFUND_REASON_MIN_LENGTH) {
    return `Enter a refund reason of at least ${REFUND_REASON_MIN_LENGTH} characters.`;
  }
  if (trimmed.length > REFUND_REASON_MAX_LENGTH) {
    return `Keep the refund reason to ${REFUND_REASON_MAX_LENGTH} characters or fewer.`;
  }
  return "";
}

export function paymentMethodLabel(method: string) {
  return method === "CARD_REFERENCE" ? "Square card" : method.toLowerCase();
}

/**
 * The refund confirm dialog's body (#472): repeats the amount, reason,
 * registration, and payment exactly as they're about to be recorded, so
 * confirming is never a guess about what's about to happen. A standalone
 * component (rather than inline JSX in `FinanceWorkspace`) so the review
 * content itself can be rendered and checked without mounting the whole
 * stateful finance workspace.
 */
export function RefundReviewFacts({
  amountCents,
  reason,
  registrationLabel,
  paymentAmountCents,
  paymentMethod,
}: {
  amountCents: number;
  reason: string;
  registrationLabel: string;
  paymentAmountCents: number;
  paymentMethod: string;
}) {
  return (
    <dl className="confirm-dialog-facts">
      <div><dt>Amount</dt><dd>{money(amountCents)}</dd></div>
      <div><dt>Reason</dt><dd>{reason}</dd></div>
      <div><dt>Registration</dt><dd>{registrationLabel}</dd></div>
      <div><dt>Payment</dt><dd>{money(paymentAmountCents)} · {paymentMethodLabel(paymentMethod)}</dd></div>
    </dl>
  );
}
