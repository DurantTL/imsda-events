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

## Payments taken outside the app

Money is regularly taken in Square without going through this app — a Square
invoice, a payment link, or the Virtual Terminal, most often for a registration
that was imported rather than submitted here. Those payments carry no IMSDA
payment attempt, so until the webhook learned to match them by confirmation
code they were recorded as `IGNORED` and the registration read as unpaid
forever.

The webhook now applies one only when every axis is unambiguous:

- Square reports it `COMPLETED`, in USD, at the configured location.
- Its `note` or `reference_id` names exactly one confirmation code. A candidate
  must contain a digit, so ordinary prose in a note cannot be looked up as a
  code — and a confirmation code with no digit at all is deliberately never
  auto-applied.
- That code resolves to exactly one `SUBMITTED` or `CONFIRMED` registration.
  Confirmation codes are unique within an event, not across the database.
- The amount equals that registration's outstanding balance to the cent.

Anything short of that is recorded as `IGNORED` with the reason that stopped
it, for a human to settle. The provider payment id keeps it idempotent across
`payment.created` and `payment.updated`.

To take money in Square for an existing registration, put its confirmation code
in the payment's note or reference and charge exactly the balance shown in
IMSDA Events.

## Reconciliation

`npm run payments:reconcile -- --days 30` lists every completed Square payment
for the configured location in a window and reports the ones this database
never recorded, alongside every webhook delivery that was received and declined.
It is read-only — it takes no money and writes nothing — so it is safe to run
against Production, and it is the check to run after any close date.

An empty findings list with declined deliveries present means Square is
reaching the endpoint but nothing is attaching. No findings and no deliveries
at all means Square is not reaching the endpoint: check
`SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_NOTIFICATION_URL` against
Square, since a mismatch rejects every real payment result.

## Matching a payment by hand

**Finance → Unmatched Square payments** lists every completed Square payment
this database never recorded and lets a finance manager attach one to a
registration. It is the fallback for money taken through a channel that carries
no confirmation code at all — a separate registration site, a Square Online
order, an invoice — where nothing can be matched automatically and the Square
note is the only evidence of who paid.

The rules that keep it honest:

- `MANAGE_FINANCE` only, and cross-origin requests are rejected.
- The browser names the provider payment and the registration; it never says
  what the payment was worth. The amount, status, and location are re-read from
  Square server-side, so a tampered request cannot invent or inflate a payment.
- The recorded amount is exactly what Square took. Where that exceeds the
  outstanding balance — typically the card fee the payer was charged on top —
  the registration is left showing the overpayment rather than having its total
  quietly rewritten. Why the gap exists is a finance judgement, not something
  to infer.
- A provider payment already recorded anywhere is refused, inside the
  transaction, so two staff working the same list cannot double-record it.
- No receipt is sent. These payments are routinely weeks old, and a surprise
  receipt for money already paid causes more confusion than it settles.
- Every attachment writes a `SQUARE_PAYMENT_MANUALLY_MATCHED` audit record
  naming the staff member, the provider payment, and the overpayment.

### Two reference namespaces

The reference this app records is not the only one in circulation. The WR26
import copies a **"Square Payment ID"** column straight out of the source
spreadsheet, unverified (`modules/imports/wr26-bundle.ts`). Where that column
held an id from another namespace — an order id, a tender id, a legacy id —
the registration already carries the right payment under a reference Square
would not recognise.

That breaks matching on the provider id alone in both directions: the
reconciler reports the real payment as unrecorded, and attaching it creates a
second `Payment` row for money already counted. `Payment.externalReference`
carries no unique constraint, so nothing at the database level prevents it.

The guard is the amount: a successful payment on the registration for the same
amount as the provider payment refuses the attachment with
`PAYMENT_LIKELY_DUPLICATE`, and the screen makes a human confirm it is
genuinely a second payment before proceeding. The acknowledged duplicate is
recorded in the audit metadata as `acknowledgedDuplicateOf`.

`npm run payments:match-audit` lists every hand-attached payment and marks the
ones that duplicate an existing payment on the same registration.
`-- --void <paymentId> --reason "<why>"` reverses one, marking it `VOIDED`
rather than deleting it: balances count only successful payments, so the money
stops counting while the history and its audit trail survive. It refuses to
touch a payment that was not hand-attached, so it cannot become a general way
to erase payments.

There is no sandbox rehearsal for a site already on Production:
`SQUARE_ENVIRONMENT` is one setting for the whole deployment, and flipping it
would orphan live payment attempts. Reconciliation is the safe substitute.

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
