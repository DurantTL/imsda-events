import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSquareConfiguration: vi.fn(),
  processSquareWebhook: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/payments/square-config", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/modules/payments/square-config")
  >();
  return {
    ...original,
    getSquareConfiguration: mocks.getSquareConfiguration,
  };
});
vi.mock("@/modules/payments/square-repository", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/modules/payments/square-repository")
  >();
  return {
    ...original,
    processSquareWebhook: mocks.processSquareWebhook,
  };
});

import { POST } from "@/app/api/webhooks/square/route";

const notificationUrl = "https://events.imsda.test/api/webhooks/square";
const signatureKey = "sandbox-signature-key";
const rawBody = JSON.stringify({
  event_id: "square-event-1",
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
      },
    },
  },
});

function signature(body: string) {
  return createHmac("sha256", signatureKey)
    .update(notificationUrl)
    .update(body)
    .digest("base64");
}

function request(body = rawBody, signedBody = body) {
  return new Request(notificationUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-square-hmacsha256-signature": signature(signedBody),
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSquareConfiguration.mockReturnValue({
    environment: "sandbox",
    applicationId: "sandbox-sq0idb-example",
    locationId: "sandbox-location",
    accessToken: "sandbox-access-token",
    apiUrl: "https://connect.squareupsandbox.com",
    apiVersion: "2026-07-15",
    scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    webhookSignatureKey: signatureKey,
    webhookNotificationUrl: notificationUrl,
    paymentConfigured: true,
    webhookConfigured: true,
    issue: null,
  });
  mocks.processSquareWebhook.mockResolvedValue({
    status: "PROCESSED",
    duplicate: false,
  });
});

describe("Square webhook route", () => {
  it("validates the exact raw body and passes only parsed state plus its digest", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.processSquareWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: "square-event-1",
        eventType: "payment.updated",
        kind: "PAYMENT",
      }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      { configuration: expect.objectContaining({ environment: "sandbox" }) },
    );
    expect(await response.json()).toEqual({
      received: true,
      status: "PROCESSED",
      duplicate: false,
    });
  });

  it("rejects a body changed after Square signed it", async () => {
    const response = await POST(request(`${rawBody}\n`, rawBody));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "INVALID_SQUARE_SIGNATURE",
    });
    expect(mocks.processSquareWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges a deduplicated provider event", async () => {
    mocks.processSquareWebhook.mockResolvedValue({
      status: "PROCESSED",
      duplicate: true,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      received: true,
      duplicate: true,
    });
  });
});
