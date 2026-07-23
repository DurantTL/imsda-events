import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createSquarePayment,
  SquareAdapterError,
} from "@/modules/payments/square-adapter";
import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";

const configuration: SquareRuntimeConfiguration = {
  environment: "sandbox",
  applicationId: "sandbox-sq0idb-example",
  locationId: "sandbox-location",
  accessToken: "sandbox-secret-access-token",
  apiUrl: "https://connect.squareupsandbox.com",
  apiVersion: "2026-07-15",
  scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
  webhookSignatureKey: "sandbox-signature-key",
  webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
  paymentConfigured: true,
  webhookConfigured: true,
  issue: null,
};

const input = {
  sourceId: "cnon:card-nonce-ok",
  idempotencyKey: "imsda_012345678901234567890123456789012345678",
  amountCents: 12_930,
  currency: "USD" as const,
  locationId: "sandbox-location",
  referenceId: "attempt-1",
  note: "IMSDA registration REG-ONE",
};

describe("Square Payments API adapter", () => {
  it("sends the immutable cent quote and stable idempotency key", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      payment: {
        id: "square-payment-1",
        status: "COMPLETED",
        amount_money: { amount: 12_930, currency: "USD" },
        created_at: "2026-07-23T13:00:00.000Z",
        updated_at: "2026-07-23T13:00:01.000Z",
        card_details: {
          card: { last_4: "1111", fingerprint: "must-not-be-returned" },
        },
      },
    }));

    const result = await createSquarePayment(
      configuration,
      input,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://connect.squareupsandbox.com/v2/payments",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-secret-access-token",
          "Content-Type": "application/json",
          "Square-Version": "2026-07-15",
        },
        cache: "no-store",
      }),
    );
    const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      source_id: "cnon:card-nonce-ok",
      idempotency_key: input.idempotencyKey,
      amount_money: { amount: 12_930, currency: "USD" },
      autocomplete: true,
      location_id: "sandbox-location",
      reference_id: "attempt-1",
      note: "IMSDA registration REG-ONE",
    });
    expect(result).toEqual({
      id: "square-payment-1",
      status: "COMPLETED",
      amountCents: 12_930,
      currency: "USD",
      createdAt: "2026-07-23T13:00:00.000Z",
      updatedAt: "2026-07-23T13:00:01.000Z",
    });
    expect(result).not.toHaveProperty("card_details");
  });

  it("marks transport and provider availability failures as retryable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network unavailable"));

    await expect(createSquarePayment(
      configuration,
      input,
      fetcher,
    )).rejects.toMatchObject({
      code: "SQUARE_REQUEST_UNCERTAIN",
      retryable: true,
    });
  });

  it("keeps a successful but unreadable provider response retry-safe", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );

    await expect(createSquarePayment(
      configuration,
      input,
      fetcher,
    )).rejects.toMatchObject({
      code: "SQUARE_INVALID_RESPONSE",
      retryable: true,
    });
  });

  it("returns a redacted definitive rejection without retaining source data", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      errors: [{
        code: "CARD_DECLINED",
        detail: "The card was declined.",
      }],
    }, { status: 402 }));

    let caught: unknown;
    try {
      await createSquarePayment(configuration, input, fetcher);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SquareAdapterError);
    expect(caught).toMatchObject({
      code: "SQUARE_REQUEST_REJECTED",
      retryable: false,
      providerCode: "CARD_DECLINED",
      message: "The card was declined.",
    });
    expect(JSON.stringify(caught)).not.toContain(input.sourceId);
  });
});
