import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createSquarePaymentLink,
  deleteSquarePaymentLink,
} from "@/modules/payments/square-payment-link-adapter";
import { SquareAdapterError } from "@/modules/payments/square-http";
import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";
import {
  duplicateChargeEvidence,
  hostedPaymentStaleReason,
  parseSquareWebhookEvent,
  providerHostedLinkIdempotencyKey,
  providerIdempotencyKey,
  squarePaymentLinkInputSchema,
} from "@/modules/payments/square-domain";

const configuration: SquareRuntimeConfiguration = {
  environment: "sandbox",
  applicationId: "sandbox-sq0idb-example",
  locationId: "LOCATION-1",
  accessToken: "synthetic-access-token",
  apiUrl: "https://connect.squareupsandbox.com",
  apiVersion: "2026-07-15",
  scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
  webhookSignatureKey: "synthetic-key",
  webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
  paymentConfigured: true,
  webhookConfigured: true,
  issue: null,
};

const input = {
  idempotencyKey: "imsdalink_synthetic",
  amountCents: 10_290,
  currency: "USD" as const,
  locationId: "LOCATION-1",
  referenceId: "attempt-1",
  itemName: "IMSDA registration WR26-0001",
  paymentNote: "IMSDA registration WR26-0001",
  redirectUrl: "https://events.imsda.test/manage/token?pay=square",
};

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("Square payment link adapter (#327)", () => {
  it("creates the link from one explicit order line and sends nothing about the payer", async () => {
    const fetcher = respond(200, {
      payment_link: {
        id: "LINK-1",
        order_id: "ORDER-1",
        url: "https://sandbox.square.link/u/abc",
      },
    });
    const link = await createSquarePaymentLink(configuration, input, fetcher);
    expect(link).toEqual({
      id: "LINK-1",
      orderId: "ORDER-1",
      url: "https://sandbox.square.link/u/abc",
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      idempotency_key: "imsdalink_synthetic",
      order: {
        location_id: "LOCATION-1",
        reference_id: "attempt-1",
        line_items: [{
          name: "IMSDA registration WR26-0001",
          quantity: "1",
          base_price_money: { amount: 10_290, currency: "USD" },
        }],
      },
      checkout_options: { redirect_url: "https://events.imsda.test/manage/token?pay=square" },
      payment_note: "IMSDA registration WR26-0001",
    });
    expect(JSON.stringify(body)).not.toMatch(/pre_populated|buyer|email|phone/i);
  });

  it("refuses a response without an https checkout url and treats it as retryable", async () => {
    const fetcher = respond(200, {
      payment_link: { id: "LINK-1", order_id: "ORDER-1", url: "http://insecure.example/x" },
    });
    await expect(createSquarePaymentLink(configuration, input, fetcher)).rejects.toMatchObject({
      code: "SQUARE_INVALID_RESPONSE",
      retryable: true,
    });
  });

  it("separates a rejected request from one whose result is unknown", async () => {
    await expect(createSquarePaymentLink(
      configuration,
      input,
      respond(400, { errors: [{ code: "INVALID_VALUE", detail: "Bad amount." }] }),
    )).rejects.toMatchObject({ code: "SQUARE_REQUEST_REJECTED", retryable: false, providerCode: "INVALID_VALUE" });
    await expect(createSquarePaymentLink(configuration, input, respond(503, {})))
      .rejects.toMatchObject({ code: "SQUARE_REQUEST_UNCERTAIN", retryable: true });
    await expect(createSquarePaymentLink(
      configuration,
      input,
      vi.fn(async () => { throw new Error("network"); }),
    )).rejects.toBeInstanceOf(SquareAdapterError);
  });

  it("does not call Square when it is not configured", async () => {
    const fetcher = respond(200, {});
    await expect(createSquarePaymentLink(
      { ...configuration, paymentConfigured: false },
      input,
      fetcher,
    )).rejects.toMatchObject({ code: "SQUARE_NOT_CONFIGURED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deletes a link, reports the order it cancelled, and counts a missing link as done", async () => {
    const ok = respond(200, { id: "LINK-1", cancelled_order_id: "ORDER-1" });
    await expect(deleteSquarePaymentLink(configuration, "LINK-1", ok))
      .resolves.toEqual({ alreadyGone: false, cancelledOrderId: "ORDER-1" });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/online-checkout/payment-links/LINK-1");
    expect(init.method).toBe("DELETE");
    await expect(deleteSquarePaymentLink(configuration, "LINK-1", respond(404, {})))
      .resolves.toEqual({ alreadyGone: true, cancelledOrderId: null });
    await expect(deleteSquarePaymentLink(configuration, "LINK-1", respond(500, {})))
      .rejects.toMatchObject({ retryable: true });
  });
});

describe("hosted link domain rules (#327)", () => {
  it("accepts a payment only while it still fits the balance it was quoted for", () => {
    const payable = { registrationStatus: "CONFIRMED", quotedBalanceCents: 10_000 };
    expect(hostedPaymentStaleReason({ ...payable, balanceCents: 10_000 })).toBeNull();
    // The balance grew (an adjustment): a smaller payment is still a valid partial payment.
    expect(hostedPaymentStaleReason({ ...payable, balanceCents: 12_000 })).toBeNull();
    expect(hostedPaymentStaleReason({ ...payable, balanceCents: 0 })).toBe("BALANCE_ALREADY_PAID");
    expect(hostedPaymentStaleReason({ ...payable, balanceCents: 4_000 })).toBe("BALANCE_CHANGED");
    expect(hostedPaymentStaleReason({
      registrationStatus: "CANCELED",
      balanceCents: 10_000,
      quotedBalanceCents: 10_000,
    })).toBe("REGISTRATION_NOT_PAYABLE");
  });

  it("keeps hosted and embedded provider idempotency keys in separate spaces", () => {
    const hosted = providerHostedLinkIdempotencyKey("registration-1", "00000000-0000-4000-8000-000000000001");
    expect(hosted).toMatch(/^imsdalink_[0-9a-f]{39}$/);
    expect(hosted).toBe(providerHostedLinkIdempotencyKey("registration-1", "00000000-0000-4000-8000-000000000001"));
    expect(hosted).not.toBe(providerIdempotencyKey("registration-1", "00000000-0000-4000-8000-000000000001"));
  });

  it("asks only for a request key, never an amount", () => {
    const key = "00000000-0000-4000-8000-000000000001";
    expect(squarePaymentLinkInputSchema.parse({ idempotencyKey: key })).toEqual({ idempotencyKey: key });
    expect(() => squarePaymentLinkInputSchema.parse({ idempotencyKey: key, amountCents: 1 })).toThrow();
    expect(() => squarePaymentLinkInputSchema.parse({ idempotencyKey: "not-a-uuid" })).toThrow();
  });

  it("keeps only identifiers, status, amount and timestamps as duplicate-charge evidence", () => {
    const evidence = duplicateChargeEvidence({
      id: "PAY-1",
      status: "COMPLETED",
      amount_money: { amount: 5_000, currency: "USD" },
      order_id: "ORDER-1",
      created_at: "2026-10-09T10:00:00Z",
      card_details: { card: { last_4: "1111" } },
      buyer_email_address: "someone@example.test",
    } as never);
    expect(Object.keys(evidence).sort()).toEqual([
      "amount_money", "created_at", "id", "location_id", "order_id", "reference_id", "status", "updated_at",
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/1111|someone@/);
  });

  it("reads the order id off a payment webhook", () => {
    const event = parseSquareWebhookEvent({
      event_id: "evt-1",
      type: "payment.updated",
      created_at: "2026-10-09T10:00:00Z",
      data: {
        object: {
          payment: {
            id: "PAY-1",
            status: "COMPLETED",
            amount_money: { amount: 5_000, currency: "USD" },
            order_id: "ORDER-1",
          },
        },
      },
    });
    expect(event.payment?.order_id).toBe("ORDER-1");
  });
});
