import "server-only";

import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";

export type SquarePaymentStatus =
  | "APPROVED"
  | "PENDING"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED"
  | string;

export type SquarePaymentResult = {
  id: string;
  status: SquarePaymentStatus;
  amountCents: number;
  currency: string;
  createdAt: string | null;
  updatedAt: string | null;
};

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

type CreateSquarePaymentInput = {
  sourceId: string;
  idempotencyKey: string;
  amountCents: number;
  currency: "USD";
  locationId: string;
  referenceId: string;
  note: string;
};

type Fetcher = typeof fetch;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function providerError(value: unknown) {
  const body = record(value);
  const first = Array.isArray(body.errors) ? record(body.errors[0]) : {};
  return {
    code: typeof first.code === "string" ? first.code : null,
    detail: typeof first.detail === "string"
      ? first.detail
      : "Square could not process this payment request.",
  };
}

export async function createSquarePayment(
  configuration: SquareRuntimeConfiguration,
  input: CreateSquarePaymentInput,
  fetcher: Fetcher = fetch,
): Promise<SquarePaymentResult> {
  if (!configuration.paymentConfigured) {
    throw new SquareAdapterError(
      "SQUARE_NOT_CONFIGURED",
      "Online card payment is not configured for this site.",
      false,
    );
  }

  let response: Response;
  try {
    response = await fetcher(`${configuration.apiUrl}/v2/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": configuration.apiVersion,
      },
      body: JSON.stringify({
        source_id: input.sourceId,
        idempotency_key: input.idempotencyKey,
        amount_money: {
          amount: input.amountCents,
          currency: input.currency,
        },
        autocomplete: true,
        location_id: input.locationId,
        reference_id: input.referenceId,
        note: input.note,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new SquareAdapterError(
      "SQUARE_REQUEST_UNCERTAIN",
      "Square did not confirm the payment request. It is safe to retry.",
      true,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const retryable = response.ok
      || response.status === 408
      || response.status === 409
      || response.status === 429
      || response.status >= 500;
    throw new SquareAdapterError(
      response.ok
        ? "SQUARE_INVALID_RESPONSE"
        : retryable
          ? "SQUARE_REQUEST_UNCERTAIN"
          : "SQUARE_REQUEST_REJECTED",
      "Square returned an unreadable payment response.",
      retryable,
    );
  }

  if (!response.ok) {
    const error = providerError(body);
    const retryable = response.status === 408
      || response.status === 409
      || response.status === 429
      || response.status >= 500;
    throw new SquareAdapterError(
      retryable ? "SQUARE_REQUEST_UNCERTAIN" : "SQUARE_REQUEST_REJECTED",
      error.detail,
      retryable,
      error.code,
    );
  }

  const payment = record(record(body).payment);
  const amountMoney = record(payment.amount_money);
  const id = typeof payment.id === "string" ? payment.id : "";
  const status = typeof payment.status === "string" ? payment.status : "";
  const amountCents = typeof amountMoney.amount === "number"
    && Number.isSafeInteger(amountMoney.amount)
    ? amountMoney.amount
    : Number.NaN;
  const currency = typeof amountMoney.currency === "string"
    ? amountMoney.currency
    : "";
  if (!id || !status || !Number.isSafeInteger(amountCents) || !currency) {
    throw new SquareAdapterError(
      "SQUARE_INVALID_RESPONSE",
      "Square returned an incomplete payment response.",
      true,
    );
  }

  return {
    id,
    status,
    amountCents,
    currency,
    createdAt: typeof payment.created_at === "string"
      ? payment.created_at
      : null,
    updatedAt: typeof payment.updated_at === "string"
      ? payment.updated_at
      : null,
  };
}
