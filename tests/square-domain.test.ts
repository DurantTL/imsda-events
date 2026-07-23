import { describe, expect, it } from "vitest";
import {
  internalPaymentState,
  internalRefundStatus,
  parseSquareWebhookEvent,
  providerIdempotencyKey,
  registrationBalanceCents,
  selectedCardPayment,
  squareWebhookPayloadHash,
  verifySquareWebhookSignature,
} from "@/modules/payments/square-domain";

const definition = {
  title: "Payment test",
  description: "",
  confirmationMessage: "Received.",
  payment: {
    enabled: true,
    currency: "USD",
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Credit / debit card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [{
    id: "payment-section",
    title: "Payment",
    description: "",
    fields: [{
      id: "payment-method",
      key: "payment_method",
      label: "Payment method",
      helpText: "",
      type: "RADIO",
      scope: "REGISTRATION",
      required: true,
      options: ["Pay later", "Credit / debit card"],
    }],
  }],
};

describe("Square payment domain", () => {
  it("uses only an immutable published form response to enable card payment", () => {
    expect(selectedCardPayment({
      definition,
      responses: { payment_method: "Credit / debit card" },
      formVersionStatus: "PUBLISHED",
    })).toEqual({ configured: true, cardSelected: true });
    expect(selectedCardPayment({
      definition,
      responses: { payment_method: "Pay later" },
      formVersionStatus: "PUBLISHED",
    })).toEqual({ configured: true, cardSelected: false });
    expect(selectedCardPayment({
      definition,
      responses: { payment_method: "Credit / debit card" },
      formVersionStatus: "ARCHIVED",
    })).toEqual({ configured: false, cardSelected: false });
  });

  it("calculates the server balance net of successful refunds", () => {
    expect(registrationBalanceCents({
      totalAmount: 150,
      payments: [{
        amount: 80,
        refunds: [{ amount: 10 }],
      }],
    })).toBe(8_000);
  });

  it("derives a stable provider idempotency key within Square's 45-character limit", () => {
    const first = providerIdempotencyKey(
      "registration-1",
      "d67776d0-f79d-4e8f-bec2-ee61abb7337c",
    );
    const second = providerIdempotencyKey(
      "registration-1",
      "d67776d0-f79d-4e8f-bec2-ee61abb7337c",
    );
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(45);
  });

  it("validates Square's documented webhook signature vector in constant-length form", () => {
    const rawBody = '{"hello":"world"}';
    expect(verifySquareWebhookSignature({
      rawBody,
      notificationUrl: "https://example.com/webhook",
      signatureKey: "asdf1234",
      signatureHeader: "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=",
    })).toBe(true);
    expect(verifySquareWebhookSignature({
      rawBody: `${rawBody} `,
      notificationUrl: "https://example.com/webhook",
      signatureKey: "asdf1234",
      signatureHeader: "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=",
    })).toBe(false);
  });

  it("parses only the payment fields needed for durable state", () => {
    const event = parseSquareWebhookEvent({
      event_id: "event-1",
      type: "payment.updated",
      created_at: "2026-07-23T13:00:00.000Z",
      data: {
        type: "payment",
        id: "square-payment-1",
        object: {
          payment: {
            id: "square-payment-1",
            status: "COMPLETED",
            amount_money: { amount: 12_930, currency: "USD" },
            location_id: "sandbox-location",
            reference_id: "attempt-1",
            card_details: {
              card: { last_4: "1111", fingerprint: "not-persisted" },
            },
          },
        },
      },
    });

    expect(event).toMatchObject({
      providerEventId: "event-1",
      eventType: "payment.updated",
      kind: "PAYMENT",
      payment: {
        id: "square-payment-1",
        status: "COMPLETED",
      },
    });
    expect(squareWebhookPayloadHash(JSON.stringify(event))).toHaveLength(64);
    expect(internalPaymentState("COMPLETED")).toMatchObject({
      attemptStatus: "SUCCEEDED",
      paymentStatus: "SUCCEEDED",
    });
    expect(internalRefundStatus("COMPLETED")).toBe("SUCCEEDED");
  });
});
