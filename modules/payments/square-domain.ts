import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  processingFeeForSubtotal,
  registrationFormDefinitionSchema,
} from "@/modules/forms/definition";
import type {
  PromotedWaitlistPaymentChoiceView,
} from "@/modules/payments/payment-choice-domain";

export const squarePaymentInputSchema = z.strictObject({
  sourceId: z.string().trim().min(3).max(512).refine(
    (value) => !/\s/.test(value),
    "The payment token is invalid.",
  ),
  idempotencyKey: z.uuid(),
});

export type SquarePaymentInput = z.infer<typeof squarePaymentInputSchema>;

/** Asking for a "Pay on Square" link (#327): only a request key, never an amount. */
export const squarePaymentLinkInputSchema = z.strictObject({
  idempotencyKey: z.uuid(),
});

export type SquarePaymentLinkInput = z.infer<typeof squarePaymentLinkInputSchema>;

/**
 * How long a hosted link stays payable. Square's payment link has no expiry setting, so this app
 * enforces it: a link older than this is refused on replay and deleted at Square by the sweep.
 */
export const hostedLinkLifetimeMs = 24 * 60 * 60 * 1000;

export type SquareHostedLinkView = {
  url: string;
  amountCents: number;
  balanceCents: number;
  surchargeCents: number;
  currency: "USD";
  expiresAt: string;
};

export type SquareCheckoutState =
  | "READY"
  | "CHOICE_REQUIRED"
  | "NOT_CONFIGURED"
  | "NOT_ELIGIBLE"
  | "NO_BALANCE"
  | "FORM_UNAVAILABLE";

/**
 * What a church-billed registration's payment endpoints return (#621): a state and a message,
 * never an amount, balance, surcharge or payment-choice total.
 */
export type SquareChurchBilledCheckoutView = {
  state: "NOT_ELIGIBLE";
  message: string;
  currency: "USD";
  /** Never present: a church-billed registration has no card checkout. */
  square?: undefined;
};

export type SquareCheckoutView = SquareChurchBilledCheckoutView | SquarePayableCheckoutView;

export type SquarePayableCheckoutView = {
  state: SquareCheckoutState;
  message: string;
  /** What the card is charged: the outstanding balance plus any surcharge. */
  amountCents: number;
  /** The registration's outstanding balance, before any card surcharge. */
  balanceCents: number;
  /**
   * The card processing surcharge inside `amountCents`. Non-zero only when
   * the registration's total did not already price a card fee in, which is
   * the pay-later registrant settling their balance by card.
   */
  surchargeCents: number;
  currency: "USD";
  cardSelected: boolean;
  /**
   * Whether the event offers "Pay on Square" (#327) and this registration can use it right now.
   * Carries no address: a link is created on request, for the amount quoted at that moment.
   */
  hostedLink: boolean;
  paymentChoice: PromotedWaitlistPaymentChoiceView | null;
  square: {
    environment: "sandbox" | "production";
    applicationId: string;
    locationId: string;
    scriptUrl: string;
  } | null;
  billingContact: {
    givenName: string;
    familyName: string;
    email: string;
    phone: string;
  } | null;
};

export function moneyToCents(value: { toString(): string } | number) {
  return Math.max(0, Math.round(Number(value) * 100));
}

export function registrationBalanceCents(input: {
  totalAmount: { toString(): string } | number;
  payments: Array<{
    amount: { toString(): string } | number;
    refunds: Array<{ amount: { toString(): string } | number }>;
  }>;
}) {
  const netPaid = input.payments.reduce((total, payment) => {
    const refunded = payment.refunds.reduce(
      (sum, refund) => sum + moneyToCents(refund.amount),
      0,
    );
    return total + moneyToCents(payment.amount) - refunded;
  }, 0);
  return Math.max(moneyToCents(input.totalAmount) - netPaid, 0);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function selectedCardPayment(input: {
  definition: unknown;
  responses: unknown;
  /**
   * Whether the owning form still has a PUBLISHED version — not the
   * submitted version's own status, and not the form-level status. A version
   * is archived the moment a newer one is published, so gating on it would
   * strand every earlier registrant without online payment the instant staff
   * fix a typo; and the form-level status can read DRAFT while a live version
   * still serves (a draft beside it, #564). What determines whether a card
   * payment can be taken is whether the form is live at all — the submitted
   * version's definition still decides the payment fields and pricing.
   */
  formHasPublishedVersion: boolean;
}) {
  if (!input.formHasPublishedVersion) {
    return { configured: false, cardSelected: false };
  }
  const definition = registrationFormDefinitionSchema.safeParse(
    input.definition,
  );
  if (!definition.success || !definition.data.payment?.enabled) {
    return { configured: false, cardSelected: false };
  }
  const payment = definition.data.payment;
  const responses = record(input.responses);
  return {
    configured: true,
    cardSelected:
      responses[payment.paymentMethodFieldKey] === payment.cardOptionValue,
  };
}

/**
 * The card processing surcharge for settling `balanceCents` by card.
 *
 * A registration priced for card already carries its fee in the total, so it
 * gets none. A pay-later one does not, and paying it by card later is the
 * same transaction the card path always charged for — so it is charged the
 * same way, grossed up so the conference still nets the balance owed. An
 * event that absorbs the fee (`passFeeToRegistrant` off) gets zero here, the
 * same as it does at registration.
 *
 * Computed on the outstanding balance rather than the original subtotal:
 * someone who already sent a cheque for half is only running the remainder
 * through the card, and that remainder is all the processor charges on.
 */
export function cardSurchargeForBalance(
  definition: unknown,
  balanceCents: number,
) {
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  if (!parsed.success) return 0;
  return processingFeeForSubtotal(parsed.data.payment, balanceCents, true);
}

export function providerIdempotencyKey(
  registrationId: string,
  clientIdempotencyKey: string,
) {
  const digest = createHash("sha256")
    .update(`${registrationId}:${clientIdempotencyKey}`)
    .digest("hex");
  return `imsda_${digest.slice(0, 39)}`;
}

/** A separate key space from embedded payments, so one client key can never name both. */
export function providerHostedLinkIdempotencyKey(
  registrationId: string,
  clientIdempotencyKey: string,
) {
  const digest = createHash("sha256")
    .update(`hosted-link:${registrationId}:${clientIdempotencyKey}`)
    .digest("hex");
  return `imsdalink_${digest.slice(0, 39)}`;
}

export type HostedLinkStaleReason =
  | "REGISTRATION_NOT_PAYABLE"
  | "BALANCE_ALREADY_PAID"
  | "BALANCE_CHANGED";

/**
 * Whether a payment quoted for `quotedBalanceCents` can still be applied to the registration.
 *
 * "First successfully recorded payment wins": once the outstanding balance has fallen below what
 * the attempt was quoted for (another card payment, a cheque staff recorded, an adjustment), the
 * attempt's money no longer fits. A balance that has grown still accepts the payment; it is a
 * partial payment of something larger, and the processor has already taken it.
 */
export function hostedPaymentStaleReason(input: {
  registrationStatus: string;
  balanceCents: number;
  quotedBalanceCents: number;
}): HostedLinkStaleReason | null {
  if (
    input.registrationStatus !== "SUBMITTED"
    && input.registrationStatus !== "CONFIRMED"
  ) {
    return "REGISTRATION_NOT_PAYABLE";
  }
  if (input.balanceCents <= 0) return "BALANCE_ALREADY_PAID";
  if (input.balanceCents < input.quotedBalanceCents) return "BALANCE_CHANGED";
  return null;
}

/**
 * What a duplicate-charge record keeps of Square's payment: ids, status, amount, and timestamps.
 * Deliberately not the card details, receipt URL, or buyer fields Square's payment also carries.
 */
export function duplicateChargeEvidence(payment: {
  id: string;
  status: string;
  amount_money: { amount: number; currency: string };
  order_id?: string | undefined;
  location_id?: string | undefined;
  reference_id?: string | undefined;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}) {
  return {
    id: payment.id,
    status: payment.status,
    amount_money: {
      amount: payment.amount_money.amount,
      currency: payment.amount_money.currency,
    },
    order_id: payment.order_id ?? null,
    location_id: payment.location_id ?? null,
    reference_id: payment.reference_id ?? null,
    created_at: payment.created_at ?? null,
    updated_at: payment.updated_at ?? null,
  };
}

export function squareWebhookPayloadHash(rawBody: string) {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function verifySquareWebhookSignature(input: {
  rawBody: string;
  notificationUrl: string;
  signatureKey: string;
  signatureHeader: string;
}) {
  if (
    !input.notificationUrl
    || !input.signatureKey
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signatureHeader)
  ) {
    return false;
  }
  const expected = createHmac("sha256", input.signatureKey)
    .update(input.notificationUrl)
    .update(input.rawBody)
    .digest();
  const received = Buffer.from(input.signatureHeader, "base64");
  return received.length === expected.length
    && timingSafeEqual(received, expected);
}

const squareMoneySchema = z.strictObject({
  amount: z.number().int().safe(),
  currency: z.string().trim().min(3).max(3),
});

const squarePaymentObjectSchema = z.object({
  id: z.string().trim().min(1).max(255),
  status: z.string().trim().min(1).max(40),
  amount_money: squareMoneySchema,
  location_id: z.string().trim().min(1).max(255).optional(),
  reference_id: z.string().trim().min(1).max(255).optional(),
  /** Set on a payment made through a hosted checkout link (#327), which has no `reference_id`. */
  order_id: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().max(500).optional(),
  created_at: z.string().datetime({ offset: true }).optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
}).passthrough();

const squareRefundObjectSchema = z.object({
  id: z.string().trim().min(1).max(255),
  status: z.string().trim().min(1).max(40),
  amount_money: squareMoneySchema,
  payment_id: z.string().trim().min(1).max(255),
  location_id: z.string().trim().min(1).max(255).optional(),
  created_at: z.string().datetime({ offset: true }).optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
}).passthrough();

const squareWebhookEnvelopeSchema = z.object({
  event_id: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(120),
  created_at: z.string().datetime({ offset: true }).optional(),
  data: z.object({
    type: z.string().optional(),
    id: z.string().optional(),
    object: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).passthrough();

export type ParsedSquareWebhookEvent = {
  providerEventId: string;
  eventType: string;
  occurredAt: Date;
  kind: "PAYMENT" | "REFUND" | "UNSUPPORTED";
  payment?: z.infer<typeof squarePaymentObjectSchema>;
  refund?: z.infer<typeof squareRefundObjectSchema>;
};

export function parseSquareWebhookEvent(
  value: unknown,
  receivedAt = new Date(),
): ParsedSquareWebhookEvent {
  const envelope = squareWebhookEnvelopeSchema.parse(value);
  const occurredAt = envelope.created_at
    ? new Date(envelope.created_at)
    : receivedAt;
  if (
    envelope.type === "payment.created"
    || envelope.type === "payment.updated"
  ) {
    return {
      providerEventId: envelope.event_id,
      eventType: envelope.type,
      occurredAt,
      kind: "PAYMENT",
      payment: squarePaymentObjectSchema.parse(
        record(envelope.data.object).payment,
      ),
    };
  }
  if (
    envelope.type === "refund.created"
    || envelope.type === "refund.updated"
  ) {
    return {
      providerEventId: envelope.event_id,
      eventType: envelope.type,
      occurredAt,
      kind: "REFUND",
      refund: squareRefundObjectSchema.parse(
        record(envelope.data.object).refund,
      ),
    };
  }
  return {
    providerEventId: envelope.event_id,
    eventType: envelope.type,
    occurredAt,
    kind: "UNSUPPORTED",
  };
}

export function internalPaymentState(providerStatus: string) {
  switch (providerStatus) {
    case "COMPLETED":
      return {
        attemptStatus: "SUCCEEDED" as const,
        paymentStatus: "SUCCEEDED" as const,
        terminal: true,
      };
    case "FAILED":
      return {
        attemptStatus: "FAILED" as const,
        paymentStatus: "FAILED" as const,
        terminal: true,
      };
    case "CANCELED":
      return {
        attemptStatus: "CANCELED" as const,
        paymentStatus: "VOIDED" as const,
        terminal: true,
      };
    default:
      return {
        attemptStatus: "PENDING" as const,
        paymentStatus: "PENDING" as const,
        terminal: false,
      };
  }
}

export function internalRefundStatus(providerStatus: string) {
  if (providerStatus === "COMPLETED") return "SUCCEEDED" as const;
  if (providerStatus === "FAILED" || providerStatus === "REJECTED") {
    return "FAILED" as const;
  }
  return "PENDING" as const;
}

/**
 * The confirmation codes a Square payment might be pointing at, read out of
 * the two free-text fields staff control when money is taken outside this
 * app: a Square invoice, a payment link, or the Virtual Terminal. A payment
 * this app created carries the attempt id in `reference_id` and is matched
 * directly, so it never reaches here.
 *
 * A candidate must contain a digit. That keeps ordinary prose in a note
 * ("IMSDA registration") from being looked up as a code, at the deliberate
 * cost of never auto-applying against a confirmation code that has no digit
 * at all — that payment is recorded as ignored with its reason and shows up
 * on the reconciliation report for a human instead.
 */
const confirmationCodeCandidatePattern = /[A-Z0-9][A-Z0-9-]{2,39}/g;

export function squareConfirmationCodeCandidates(payment: {
  note?: string | null;
  reference_id?: string | null;
}) {
  const candidates = new Set<string>();
  for (const field of [payment.note, payment.reference_id]) {
    if (typeof field !== "string") continue;
    const matches = field.toUpperCase().matchAll(
      confirmationCodeCandidatePattern,
    );
    for (const match of matches) {
      const token = match[0].replace(/-+$/, "");
      if (token.length >= 4 && /\d/.test(token)) candidates.add(token);
    }
  }
  return [...candidates].slice(0, 10);
}

/**
 * The form submission numbers a Square payment names, read from the payment
 * note and its order's line items.
 *
 * The external registration form writes "... - Submission #4259" onto the
 * payment, and the WR26 import stored that same number on each registration
 * as its FF Entry ID. It is an exact key between the two systems, which is
 * worth far more than matching on names: payers and attendees are often
 * different people, and names repeat.
 */
export function squareSubmissionNumbers(texts: Array<string | null | undefined>) {
  const numbers = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/submission\s*#\s*(\d{1,12})/gi)) {
      numbers.add(match[1]!);
    }
  }
  return [...numbers];
}
