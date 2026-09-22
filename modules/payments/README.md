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

The amount cannot settle it either. That same import records a successful
payment at the registration's **Final Amount** (`wr26-bundle.ts`), while the
external checkout charged the card fee on top — so the duplicate pair routinely
differs by the fee, on exactly the rows most at risk.

So the guard is any money at all: a registration that already shows a
successful payment refuses the attachment with `PAYMENT_LIKELY_DUPLICATE`,
returning the existing payments and their references so a person can compare
them against the Square receipt rather than trust a verdict. This screen exists
for payments nothing recorded, so a registration already showing money is worth
a second look by definition. A group paying in genuine instalments is the false
positive, and it costs one confirming press. What was acknowledged is recorded
in the audit metadata as `acknowledgedOverExistingPaymentIds`.

`npm run payments:match-audit` lists every hand-attached payment and marks the
ones sitting on a registration that already had money, showing each existing
payment and its reference beside it.
`-- --verify` asks Square whether the *other* reference on each registration is
a payment it knows. That is the fact the question turns on, and only Square can
answer it: a reference Square does not recognise is the spreadsheet's, and the
attachment beside it is the same money a second time.

Two repairs follow from that:

- `-- --relink <id>[,<id>...] --reason "<why>"` moves the real provider id onto
  the payment the import already created and voids the attachment. The money is
  counted once *and* carries the id Square uses, so reconciliation stops
  reporting it. This is the right repair whenever the import recorded the
  payment under an unrecognised reference.
- `-- --link <squareId>=<code>[,...] --reason "<why>"` does the same repair for
  a payment nobody attached by hand. `--relink` finds its pair through the
  attachment; a payment that was never attached leaves no such trail, so a
  person reads the Square receipt and names the registration. It refuses when
  the existing reference *is* a payment Square knows — that is two real
  payments, not one mislabelled — and tells you to attach through Finance
  instead when the registration has no matching payment to point at.
- `-- --auto-link` proposes every pair at once, reading the person's name from
  each Square note — the same evidence a staff member reads off the receipt.
  It offers every adjacent pair of words in the note to the database rather
  than assuming a separator, because the note's shape belongs to whichever
  channel took the money and varies between them. A pair naming nobody matches
  nothing, so generosity here is free.

  The payment note is only half the evidence. A payment-link or Square Online
  checkout writes what was bought — usually the attendee — onto the **order's
  line items** and leaves the note generic, so each order is read as well
  (`GET /v2/orders/{id}`, which needs the `ORDERS_READ` permission; without it
  the order is skipped and the note alone is used). Every `[pair]` line prints
  which name matched, whether it was the account holder or an attendee, and
  the evidence it came from, so the dry run can actually be checked. Skips
  print the evidence too.
  Doing a backlog of these by hand means one chance per row to transpose two
  same-amount payments, and a transposition is silent and permanent: both
  registrations keep the right money, so nothing downstream notices they hold
  each other's provider reference. A pair is proposed only when the name
  resolves to exactly one payable registration, that registration holds exactly
  one successful payment for exactly the provider's amount, and Square does not
  recognise the reference it currently carries. Anything less is printed as a
  skip with its reason. Two proposals landing on one registration abort the
  whole run. It writes nothing without `--commit --reason "<why>"`.
- `-- --void <id>[,<id>...] --reason "<why>"` only reverses the attachment,
  leaving the bad reference in place. Use it when the existing payment is
  genuinely unrelated. Reconciliation will keep reporting that Square payment
  as unrecorded, because as far as the database is concerned it still is.

Both mark payments `VOIDED` rather than deleting them: balances count only
successful payments, so the money stops counting while the history and its
audit trail survive. Both refuse any payment that was not hand-attached, so
neither can become a general way to erase payments, and `--relink` additionally
refuses unless exactly one same-amount payment sits beside the attachment —
an ambiguous pair needs a person to choose.

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
