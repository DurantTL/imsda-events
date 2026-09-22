import { describe, expect, it, vi } from "vitest";

import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config-domain";
import {
  getSquareOrderText,
  listSquarePayments,
} from "@/modules/payments/square-http";

const configuration: SquareRuntimeConfiguration = {
  environment: "production",
  applicationId: "sq0idb-example",
  locationId: "main-location",
  accessToken: "access-token",
  apiUrl: "https://connect.squareup.com",
  apiVersion: "2026-07-15",
  scriptUrl: "https://web.squarecdn.com/v1/square.js",
  webhookSignatureKey: "signature-key",
  webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
  paymentConfigured: true,
  webhookConfigured: true,
  issue: null,
};

describe("reading the attendee off a Square order", () => {
  // A payment-link checkout leaves the payment note generic and writes what
  // was bought — the attendee — onto the order's line items.
  it("returns each line item's name, variation and note", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      order: {
        line_items: [
          { name: "Women's Retreat 2026 – Jane Doe", variation_name: "Regular" },
          { name: "Shirt", note: "size M" },
        ],
      },
    }));

    const text = await getSquareOrderText(configuration, "order-1", fetcher);

    expect(text).toEqual([
      "Women's Retreat 2026 – Jane Doe",
      "Regular",
      "Shirt",
      "size M",
    ]);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://connect.squareup.com/v2/orders/order-1",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });

  it("returns an empty list for an order with no line items", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ order: {} }));

    expect(await getSquareOrderText(configuration, "order-1", fetcher))
      .toEqual([]);
  });

  // Most often the token was never granted ORDERS_READ. That must degrade to
  // "no evidence here", not abort a run that has other evidence to use.
  it.each([
    ["a forbidden token", Response.json({ errors: [] }, { status: 403 })],
    ["a missing order", Response.json({ errors: [] }, { status: 404 })],
    ["an unreadable body", new Response("not json", { status: 200 })],
  ])("returns null rather than throwing on %s", async (_label, response) => {
    const fetcher = vi.fn().mockResolvedValue(response);

    expect(await getSquareOrderText(configuration, "order-1", fetcher))
      .toBeNull();
  });

  it("returns null when Square cannot be reached", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));

    expect(await getSquareOrderText(configuration, "order-1", fetcher))
      .toBeNull();
  });

  it("carries the order id on each listed payment", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      payments: [
        {
          id: "payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12_904, currency: "USD" },
          order_id: "order-1",
        },
        {
          id: "payment-2",
          status: "COMPLETED",
          amount_money: { amount: 900, currency: "USD" },
        },
      ],
    }));

    const { payments } = await listSquarePayments(
      configuration,
      { beginTime: "2026-07-01T00:00:00.000Z" },
      fetcher,
    );

    expect(payments.map((payment) => payment.orderId)).toEqual([
      "order-1",
      null,
    ]);
  });
});
