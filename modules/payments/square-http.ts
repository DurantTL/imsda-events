/**
 * The Square HTTP boundary's error type, shared response helpers, and the
 * read-only payment listing, deliberately free of the `server-only` guard so
 * operational tooling can run the same listing the app would rather than
 * restating it and drifting. `square-adapter` re-exports all of it; import
 * that from anything running inside the app.
 *
 * Nothing here moves money. The one call that does — creating a payment —
 * stays behind the guard in `square-adapter`.
 */
import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config-domain";

export type Fetcher = typeof fetch;

export class SquareAdapterError extends Error {
  constructor(
    public readonly code:
      | "SQUARE_NOT_CONFIGURED"
      | "SQUARE_REQUEST_REJECTED"
      | "SQUARE_REQUEST_UNCERTAIN"
      | "SQUARE_INVALID_RESPONSE",
    message: string,
    public readonly retryable: boolean,
    public readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = "SquareAdapterError";
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function providerError(value: unknown) {
  const body = record(value);
  const first = Array.isArray(body.errors) ? record(body.errors[0]) : {};
  return {
    code: typeof first.code === "string" ? first.code : null,
    detail: typeof first.detail === "string"
      ? first.detail
      : "Square could not process this payment request.",
  };
}

export type SquareListedPayment = {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  note: string | null;
  referenceId: string | null;
  locationId: string | null;
  /**
   * The Square order behind the payment, when there is one. A Square Online or
   * payment-link checkout writes what was bought — often the attendee's name —
   * onto the order's line items, not onto the payment's note.
   */
  orderId: string | null;
  createdAt: string | null;
};

function squareListedPayment(
  payment: Record<string, unknown>,
): SquareListedPayment | null {
  if (typeof payment.id !== "string" || !payment.id) return null;
  const amountMoney = record(payment.amount_money);
  return {
    id: payment.id,
    status: typeof payment.status === "string" ? payment.status : "UNKNOWN",
    amountCents: typeof amountMoney.amount === "number"
      && Number.isSafeInteger(amountMoney.amount)
      ? amountMoney.amount
      : 0,
    currency: typeof amountMoney.currency === "string"
      ? amountMoney.currency
      : "",
    note: typeof payment.note === "string" ? payment.note : null,
    referenceId: typeof payment.reference_id === "string"
      ? payment.reference_id
      : null,
    locationId: typeof payment.location_id === "string"
      ? payment.location_id
      : null,
    orderId: typeof payment.order_id === "string" && payment.order_id
      ? payment.order_id
      : null,
    createdAt: typeof payment.created_at === "string"
      ? payment.created_at
      : null,
  };
}

/**
 * One page of the location's payments, newest first. Read-only, and the only
 * Square call in this codebase that is safe to run against Production from an
 * operator's terminal: it takes no money, changes nothing, and is what
 * `npm run payments:reconcile` uses to find payments Square accepted that
 * IMSDA Events never recorded.
 */
export async function listSquarePayments(
  configuration: SquareRuntimeConfiguration,
  input: {
    beginTime: string;
    endTime?: string;
    cursor?: string | null;
    limit?: number;
  },
  fetcher: Fetcher = fetch,
): Promise<{ payments: SquareListedPayment[]; cursor: string | null }> {
  if (!configuration.paymentConfigured) {
    throw new SquareAdapterError(
      "SQUARE_NOT_CONFIGURED",
      "Square is not configured for this environment.",
      false,
    );
  }
  const query = new URLSearchParams({
    location_id: configuration.locationId,
    begin_time: input.beginTime,
    sort_order: "DESC",
    limit: String(input.limit ?? 100),
  });
  if (input.endTime) query.set("end_time", input.endTime);
  if (input.cursor) query.set("cursor", input.cursor);

  let response: Response;
  try {
    response = await fetcher(
      `${configuration.apiUrl}/v2/payments?${query.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${configuration.accessToken}`,
          "Square-Version": configuration.apiVersion,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new SquareAdapterError(
      "SQUARE_REQUEST_UNCERTAIN",
      "Square did not answer the payment listing request.",
      true,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SquareAdapterError(
      "SQUARE_INVALID_RESPONSE",
      "Square returned an unreadable payment listing.",
      response.ok || response.status >= 500,
    );
  }
  if (!response.ok) {
    const error = providerError(body);
    throw new SquareAdapterError(
      response.status >= 500 || response.status === 429
        ? "SQUARE_REQUEST_UNCERTAIN"
        : "SQUARE_REQUEST_REJECTED",
      error.detail,
      response.status >= 500 || response.status === 429,
      error.code,
    );
  }

  const parsed = record(body);
  const rows = Array.isArray(parsed.payments) ? parsed.payments : [];
  const payments: SquareListedPayment[] = [];
  for (const row of rows) {
    const payment = squareListedPayment(record(row));
    if (payment) payments.push(payment);
  }
  return {
    payments,
    cursor: typeof parsed.cursor === "string" && parsed.cursor
      ? parsed.cursor
      : null,
  };
}

/**
 * One payment by its provider id. Read-only, and the server's own source of
 * truth when a staff member attaches an unmatched payment by hand: the browser
 * says which Square payment to attach, never what it was worth.
 */
export async function getSquarePayment(
  configuration: SquareRuntimeConfiguration,
  providerPaymentId: string,
  fetcher: Fetcher = fetch,
): Promise<SquareListedPayment | null> {
  if (!configuration.paymentConfigured) {
    throw new SquareAdapterError(
      "SQUARE_NOT_CONFIGURED",
      "Square is not configured for this environment.",
      false,
    );
  }
  let response: Response;
  try {
    response = await fetcher(
      `${configuration.apiUrl}/v2/payments/${encodeURIComponent(providerPaymentId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${configuration.accessToken}`,
          "Square-Version": configuration.apiVersion,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    throw new SquareAdapterError(
      "SQUARE_REQUEST_UNCERTAIN",
      "Square did not answer the payment lookup.",
      true,
    );
  }
  if (response.status === 404) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SquareAdapterError(
      "SQUARE_INVALID_RESPONSE",
      "Square returned an unreadable payment lookup.",
      response.ok || response.status >= 500,
    );
  }
  if (!response.ok) {
    const error = providerError(body);
    throw new SquareAdapterError(
      response.status >= 500 || response.status === 429
        ? "SQUARE_REQUEST_UNCERTAIN"
        : "SQUARE_REQUEST_REJECTED",
      error.detail,
      response.status >= 500 || response.status === 429,
      error.code,
    );
  }
  return squareListedPayment(record(record(body).payment));
}

/**
 * The human-readable text on a Square order's line items: each item's name,
 * variation, and note. Read-only.
 *
 * Returns null rather than throwing when the order cannot be read — most often
 * because the access token was not granted ORDERS_READ — so a caller can fall
 * back to whatever other evidence it has instead of failing the whole run.
 */
export async function getSquareOrderText(
  configuration: SquareRuntimeConfiguration,
  orderId: string,
  fetcher: Fetcher = fetch,
): Promise<string[] | null> {
  let response: Response;
  try {
    response = await fetcher(
      `${configuration.apiUrl}/v2/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${configuration.accessToken}`,
          "Square-Version": configuration.apiVersion,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const lineItems = record(record(body).order).line_items;
  if (!Array.isArray(lineItems)) return [];
  const text: string[] = [];
  for (const entry of lineItems) {
    const item = record(entry);
    for (const field of [item.name, item.variation_name, item.note]) {
      if (typeof field === "string" && field.trim()) text.push(field.trim());
    }
  }
  return text;
}
