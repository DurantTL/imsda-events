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

export type SquareCheckoutState =
  | "READY"
  | "CHOICE_REQUIRED"
  | "NOT_CONFIGURED"
  | "NOT_ELIGIBLE"
  | "NO_BALANCE"
  | "FORM_UNAVAILABLE";

export type SquareCheckoutView = {
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
   * The owning form's current status, not the submitted version's. A form
   * version is archived the moment a newer one is published, so gating on
   * the version would permanently strand every earlier registrant without
   * online payment the instant staff fix a typo. What actually determines
   * whether a card payment can be taken is whether this form is still
   * published at all — the submitted version's own definition still decides
   * the payment fields and pricing, since that is what the registrant
   * actually answered.
   */
  formStatus: string;
}) {
  if (input.formStatus !== "PUBLISHED") {
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
