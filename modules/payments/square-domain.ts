import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
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
  | "PAY_LATER"
  | "NOT_CONFIGURED"
  | "NOT_ELIGIBLE"
  | "NO_BALANCE"
  | "FORM_UNAVAILABLE";

export type SquareCheckoutView = {
  state: SquareCheckoutState;
  message: string;
  amountCents: number;
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
  formVersionStatus: string;
}) {
  if (input.formVersionStatus !== "PUBLISHED") {
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
