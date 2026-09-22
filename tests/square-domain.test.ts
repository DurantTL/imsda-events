import { describe, expect, it } from "vitest";
import {
  cardSurchargeForBalance,
  internalPaymentState,
  internalRefundStatus,
  parseSquareWebhookEvent,
  providerIdempotencyKey,
  registrationBalanceCents,
  selectedCardPayment,
  squareConfirmationCodeCandidates,
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

describe("card surcharge for a balance settled later", () => {
  it("grosses up so the conference nets the balance owed", () => {
    // 2.9% + 30c: charging 8000 + 270 leaves 8000 after Square takes its cut.
    expect(cardSurchargeForBalance(definition, 8_000)).toBe(270);
  });

  it("matches what the same amount would have been charged at registration", () => {
    for (const balance of [1_000, 5_000, 8_000, 12_345, 250_000]) {
      const surcharge = cardSurchargeForBalance(definition, balance);
      const netAfterSquare = balance + surcharge
        - Math.round((balance + surcharge) * 0.029) - 30;
      expect(netAfterSquare).toBeGreaterThanOrEqual(balance);
    }
  });

  it("charges nothing when the event absorbs the fee", () => {
    expect(cardSurchargeForBalance({
      ...definition,
      payment: { ...definition.payment, passFeeToRegistrant: false },
    }, 8_000)).toBe(0);
  });

  it("charges nothing when payment is not enabled or the definition is unusable", () => {
    expect(cardSurchargeForBalance({
      ...definition,
      payment: { ...definition.payment, enabled: false },
    }, 8_000)).toBe(0);
    expect(cardSurchargeForBalance({ not: "a form" }, 8_000)).toBe(0);
    expect(cardSurchargeForBalance(null, 8_000)).toBe(0);
  });

  it("charges nothing on a zero or negative balance", () => {
    expect(cardSurchargeForBalance(definition, 0)).toBe(0);
    expect(cardSurchargeForBalance(definition, -500)).toBe(0);
  });
});

describe("Square payment domain", () => {
  it("keys card payment eligibility off the form's current status, not the submitted version's", () => {
    expect(selectedCardPayment({
      definition,
      responses: { payment_method: "Credit / debit card" },
      formStatus: "PUBLISHED",
    })).toEqual({ configured: true, cardSelected: true });
    expect(selectedCardPayment({
      definition,
      responses: { payment_method: "Pay later" },
      formStatus: "PUBLISHED",
    })).toEqual({ configured: true, cardSelected: false });
    expect(selectedCardPayment({
      definition,
      responses: { payment_method: "Credit / debit card" },
      formStatus: "ARCHIVED",
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

describe("payment attempt surcharge migration", () => {
  it("defaults existing attempts to no surcharge and bounds it by the charge", async () => {
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(
      new URL(
        "../prisma/migrations/20260916090000_payment_attempt_surcharge/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain('ADD COLUMN "surchargeCents" INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('"surchargeCents" >= 0');
    expect(migration).toContain('"surchargeCents" <= "amountCents"');
  });
});

describe("confirmation codes inside a Square payment", () => {
  it("reads a code out of prose in the note", () => {
    expect(squareConfirmationCodeCandidates({
      note: "Womens Retreat balance WR26-4417, paid by phone",
    })).toEqual(["WR26-4417"]);
  });

  it("reads the note and the reference together, upper-cased and deduplicated", () => {
    expect(squareConfirmationCodeCandidates({
      note: "reg-00a1f2b3",
      reference_id: "REG-00A1F2B3",
    })).toEqual(["REG-00A1F2B3"]);
  });

  it("ignores prose that carries no digit, so a note alone cannot name a registration", () => {
    expect(squareConfirmationCodeCandidates({
      note: "IMSDA registration balance paid in full",
    })).toEqual([]);
  });

  it("ignores tokens too short to be a confirmation code", () => {
    expect(squareConfirmationCodeCandidates({ note: "Pew 4 A1" })).toEqual([]);
  });

  it("drops a trailing hyphen left by punctuation", () => {
    expect(squareConfirmationCodeCandidates({
      note: "WR26-4417-",
    })).toEqual(["WR26-4417"]);
  });

  it("returns nothing when neither field is present", () => {
    expect(squareConfirmationCodeCandidates({})).toEqual([]);
    expect(squareConfirmationCodeCandidates({
      note: null,
      reference_id: null,
    })).toEqual([]);
  });

  it("caps how many codes one payment can name", () => {
    const note = Array.from({ length: 30 }, (_, index) => `WR26-10${index}`)
      .join(" ");
    expect(squareConfirmationCodeCandidates({ note })).toHaveLength(10);
  });
});
