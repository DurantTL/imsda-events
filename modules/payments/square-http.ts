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
  createdAt: string | null;
};

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
    const payment = record(row);
    const amountMoney = record(payment.amount_money);
    if (typeof payment.id !== "string" || !payment.id) continue;
    payments.push({
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
      createdAt: typeof payment.created_at === "string"
        ? payment.created_at
        : null,
    });
  }
  return {
    payments,
    cursor: typeof parsed.cursor === "string" && parsed.cursor
      ? parsed.cursor
      : null,
  };
}
