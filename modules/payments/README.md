# Payments module

Owns manual payment history plus the Square Sandbox card-payment boundary.

## Square safety boundary

- Card fields are rendered by Square Web Payments only when the immutable form
  submission selected card, or a promoted waitlist registrant explicitly
  selected card through the private link, and a positive server-calculated
  balance remains.
- A waitlist submission stores no payment-method answer and no processing fee.
  Promotion preserves its discounted subtotal. The private page then presents
  card and pay-later as separate choices, including the exact card fee before
  either choice is saved.
- Promoted choices are append-only operations with optimistic concurrency,
  exact idempotent response replay, and an audit record. Choosing card
  recomputes the gross-up from the immutable discounted subtotal and updates
  the authoritative registration total in one serializable transaction.
- Payment-choice changes lock as soon as a payment starts or is recorded.
  Original answers, line items, promo redemption, and order history are never
  rewritten.
- The browser sends only Square's short-lived source token and a client UUID.
  IMSDA Events never stores the source token, PAN, CVV, expiry, or cardholder
  card metadata.
- The server independently recalculates the current balance and creates a
  durable `PaymentAttempt` before contacting Square.
- Client and provider idempotency keys are stable across uncertain retries, and
  only one active attempt may exist per registration.
- Signed `payment.created`, `payment.updated`, `refund.created`, and
  `refund.updated` webhooks are deduplicated by Square event ID. Only a payload
  hash and the minimal provider references are retained; raw webhook bodies are
  not stored.
- Card refunds must be initiated in Square. The webhook updates IMSDA Events
  after Square confirms the refund. The local refund action is intentionally
  limited to cash, check, and other manual payments.

Sandbox is the default. Production requires both
`SQUARE_ENVIRONMENT=production` and `SQUARE_ENABLE_PRODUCTION=true`, uses only
the official production origins, and must not be enabled without an approved
cutover.

## Sandbox setup

Set `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, and
`SQUARE_WEBHOOK_SIGNATURE_KEY` from a Square Sandbox application. The
`SQUARE_WEBHOOK_NOTIFICATION_URL` value must exactly match the notification URL
configured in Square. Subscribe that endpoint to:

- `payment.created`
- `payment.updated`
- `refund.created`
- `refund.updated`

The payment endpoint is private to a registration management link:
`GET|POST /api/public/manage/:token/payment`. Square sends signed notifications
to `POST /api/webhooks/square`. A promoted waitlist registrant saves an
explicit choice through `POST /api/public/manage/:token/payment-choice`; that
route never calls Square.
