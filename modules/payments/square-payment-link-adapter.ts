import "server-only";

import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";
import {
  providerError,
  record,
  SquareAdapterError,
  type Fetcher,
} from "@/modules/payments/square-http";

/**
 * Square's hosted checkout ("Pay on Square", #327): the Checkout API's payment links.
 *
 * Provider semantics this relies on, to be confirmed against Square Sandbox under #306 before
 * Production is enabled (there is no Square SDK in this repository to check them against):
 * - `POST /v2/online-checkout/payment-links` takes an `idempotency_key` and an `order`, and
 *   returns `payment_link { id, order_id, url }`. A repeat with the same key returns the same link.
 * - A payment made through the link is a normal Payment whose `order_id` is the link's order, so
 *   the existing `payment.created` / `payment.updated` webhooks carry it. It has no `reference_id`.
 * - `DELETE /v2/online-checkout/payment-links/{id}` deletes the link and cancels its order. The
 *   payment link has no expiry setting, so this is the only provider-side way to stop a link being
 *   paid, and expiry is therefore enforced by this app calling it.
 */

export type SquarePaymentLinkResult = {
  /** Square's payment link id, the handle for deleting the link. */
  id: string;
  /** The order Square created for the link; a payment through it carries this as `order_id`. */
  orderId: string;
  /** Square's hosted payment page. */
  url: string;
};

export type CreateSquarePaymentLinkInput = {
  idempotencyKey: string;
  amountCents: number;
  currency: "USD";
  locationId: string;
  /** Written to the order's `reference_id`: our payment attempt id. */
  referenceId: string;
  /** The single order line's name: the registration's confirmation code. */
  itemName: string;
  paymentNote: string;
  /** Where Square sends the payer afterwards. Never proof of payment. */
  redirectUrl: string;
};

function retryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Creates the hosted link with the amount as one explicit order line item, so the order carries
 * our attempt id. Nothing about the payer is sent: no name, email, phone, or `pre_populated_data`.
 */
export async function createSquarePaymentLink(
  configuration: SquareRuntimeConfiguration,
  input: CreateSquarePaymentLinkInput,
  fetcher: Fetcher = fetch,
): Promise<SquarePaymentLinkResult> {
  if (!configuration.paymentConfigured) {
    throw new SquareAdapterError(
      "SQUARE_NOT_CONFIGURED",
      "Online card payment is not configured for this site.",
      false,
    );
  }
  let response: Response;
  try {
    response = await fetcher(
      `${configuration.apiUrl}/v2/online-checkout/payment-links`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuration.accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": configuration.apiVersion,
        },
        body: JSON.stringify({
          idempotency_key: input.idempotencyKey,
          order: {
            location_id: input.locationId,
            reference_id: input.referenceId,
            line_items: [{
              name: input.itemName,
              quantity: "1",
              base_price_money: {
                amount: input.amountCents,
                currency: input.currency,
              },
            }],
          },
          // No tip line: the amount paid must be exactly the quote.
          checkout_options: { redirect_url: input.redirectUrl, allow_tipping: false },
          payment_note: input.paymentNote,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    throw new SquareAdapterError(
      "SQUARE_REQUEST_UNCERTAIN",
      "Square did not confirm the payment link request. It is safe to retry.",
      true,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const retryable = response.ok || retryableStatus(response.status);
    throw new SquareAdapterError(
      response.ok
        ? "SQUARE_INVALID_RESPONSE"
        : retryable
          ? "SQUARE_REQUEST_UNCERTAIN"
          : "SQUARE_REQUEST_REJECTED",
      "Square returned an unreadable payment link response.",
      retryable,
    );
  }
  if (!response.ok) {
    const error = providerError(body);
    const retryable = retryableStatus(response.status);
    throw new SquareAdapterError(
      retryable ? "SQUARE_REQUEST_UNCERTAIN" : "SQUARE_REQUEST_REJECTED",
      error.detail,
      retryable,
      error.code,
    );
  }

  const link = record(record(body).payment_link);
  const id = typeof link.id === "string" ? link.id : "";
  const orderId = typeof link.order_id === "string" ? link.order_id : "";
  const url = typeof link.url === "string" ? link.url : "";
  let secureUrl = false;
  try {
    secureUrl = new URL(url).protocol === "https:";
  } catch {
    secureUrl = false;
  }
  if (!id || !orderId || !secureUrl) {
    throw new SquareAdapterError(
      "SQUARE_INVALID_RESPONSE",
      "Square returned an incomplete payment link response.",
      true,
    );
  }
  return { id, orderId, url };
}

export type SquarePaymentLinkDeletion = {
  /** True when Square no longer had the link, which is the state wanted either way. */
  alreadyGone: boolean;
  cancelledOrderId: string | null;
};

/** Deletes the link and cancels its order. Moves no money; a link already gone counts as done. */
export async function deleteSquarePaymentLink(
  configuration: SquareRuntimeConfiguration,
  paymentLinkId: string,
  fetcher: Fetcher = fetch,
): Promise<SquarePaymentLinkDeletion> {
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
      `${configuration.apiUrl}/v2/online-checkout/payment-links/${encodeURIComponent(paymentLinkId)}`,
      {
        method: "DELETE",
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
      "Square did not confirm the payment link deletion.",
      true,
    );
  }
  if (response.status === 404) {
    return { alreadyGone: true, cancelledOrderId: null };
  }
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    if (response.ok) return { alreadyGone: false, cancelledOrderId: null };
  }
  if (!response.ok) {
    const error = providerError(body);
    const retryable = retryableStatus(response.status);
    throw new SquareAdapterError(
      retryable ? "SQUARE_REQUEST_UNCERTAIN" : "SQUARE_REQUEST_REJECTED",
      error.detail,
      retryable,
      error.code,
    );
  }
  const cancelled = record(body).cancelled_order_id;
  return {
    alreadyGone: false,
    cancelledOrderId: typeof cancelled === "string" ? cancelled : null,
  };
}
