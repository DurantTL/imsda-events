import type {
  PromotedWaitlistPaymentChoiceView,
  RegistrationPaymentChoice,
} from "@/modules/payments/payment-choice-domain";

export type PaymentChoiceOptionPresentation = {
  choice: RegistrationPaymentChoice;
  title: string;
  detail: string;
  totalCents: number;
  selected: boolean;
};

export function paymentChoiceOptionPresentations(
  view: PromotedWaitlistPaymentChoiceView,
  formatMoney: (cents: number) => string,
): PaymentChoiceOptionPresentation[] {
  return [{
    choice: "CARD",
    title: "Pay securely by card",
    detail: view.cardProcessingFeeCents > 0
      ? `Registration ${formatMoney(view.baseSubtotalCents)} + ${formatMoney(view.cardProcessingFeeCents)} card processing`
      : `Registration ${formatMoney(view.baseSubtotalCents)} · no added processing fee`,
    totalCents: view.cardTotalCents,
    selected: view.selected === "CARD",
  }, {
    choice: "PAY_LATER",
    title: "Pay later",
    detail: "No card processing fee is added.",
    totalCents: view.payLaterTotalCents,
    selected: view.selected === "PAY_LATER",
  }];
}
