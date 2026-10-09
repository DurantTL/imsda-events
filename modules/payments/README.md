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

## Pay on Square: the hosted checkout link (#327)

A second way to pay the same balance, shown beside the embedded form when staff
turn on the event's "Offer Pay on Square as a backup" setting (off by default;
the Women's Retreat, Man Camp, Camp Meeting and Hispanic Institute starters turn
it on). It is Square's own hosted page, so it does not depend on the browser SDK
rendering a wallet or a card field.

**Contract (Caleb, Sept 21 and Oct 8, 2026)**

- **Always there, never detected.** The link is offered whenever the embedded form
  is, not only when the SDK fails. Church-billed events and events with the setting
  off never offer it, and the endpoint refuses them.
- **One owner of the amount.** Asking for a link sends only a request key. The server
  quotes it with the same `checkoutFromRegistration` the embedded form uses, so the
  fee policy is Pay Later to Pay Now (#317): a pay-later registration is grossed up on
  its outstanding balance, a registration already priced for card or a promoted
  waitlist one gets no second fee, and an event that absorbs the fee gets none. The
  quote lives on the `PaymentAttempt` (channel `HOSTED_LINK`); `SquareHostedCheckout`
  only maps it to Square's link and order. Creating a link, or replaying one, never
  changes the registration total. The surcharge joins the total only when the payment
  is recorded, once, exactly as for the embedded path.
- **Idempotent.** The same request key returns the same link. A new key for the same
  open, unexpired link at the same quote returns it too, and Square's own idempotency
  key is stable per attempt, so an unconfirmed creation is retried without a second
  order. An unpaid link is an offer, not a payment in flight: it holds no
  `activeRegistrationKey` and does not lock the promoted-waitlist payment choice.
- **Only the verified webhook is proof, and Square never holds the private link.** The
  browser makes up an opaque return id (32 random bytes) and sends it with the request key;
  only its SHA-256 is stored (`returnTokenHash`, expiring with the link plus a 7-day grace).
  Square's `redirect_url` is `<APP_BASE_URL>/pay/square/return/<returnId>`, never the
  registrant's `/manage/<token>`. That page, and the poll behind it
  (`/api/public/square-return/<returnId>`), show a state (confirming, confirmed, held) and a
  masked confirmation code and nothing else; an unknown or expired id is a plain 404. Before
  leaving for Square the browser stores `sessionStorage["imsda-square-return:<returnId>"]`
  with the page it started from, when that was a private manage page; the return page sends it
  back there with `?ret=<returnId>` (removed from the address once read), where the banner
  follows the same status and refreshes the balance. With no stored page (another browser, storage
  blocked, the account portal) the return page says to use the link in the confirmation email or
  sign in. A payment through the link is a normal Square payment that carries `order_id` and no
  `reference_id`, so `payment.created` / `payment.updated` find the attempt through the stored
  order id and go through the same `applyProviderPayment` (payment row, surcharge, receipt) as
  every other payment.
- **First recorded payment wins.** Starting an embedded payment, recording any
  payment, or changing the payment choice withdraws open links (marked `INVALIDATED`
  in the same transaction, deleted at Square after commit). A payment whose webhook
  arrives while it no longer fits (`hostedPaymentStaleReason`: the registration is not
  payable, the balance is already paid, or it fell below the quoted balance) is not
  applied. A balance that grew still accepts it, as a partial payment.
- **A processor-level duplicate is evidence, not a second payment.** The payment row is
  kept `PENDING` (so the balance ignores it, no receipt, no fee), a
  `SquareDuplicateCharge` holds Square's ids, status, amount and timestamps (never
  card or payer details), a `SQUARE_DUPLICATE_CHARGE_DETECTED` audit entry is marked
  `priority: HIGH`, and an `URGENT` alert `payments.duplicate-charge.<providerPaymentId>`
  pages staff. Refunding it stays a human action in Square. The refund webhook
  records the refund, voids the held payment and resolves the record, and never
  reverses a fee the duplicate never added. An event with an unresolved production
  duplicate counts it as a real payment, so it cannot be deleted.
- **Other money through the same order is held, never applied.** A second successful payment
  on an order that already has one, or a successful payment of any amount other than the quote
  (a split payment), becomes its own `PENDING` payment row and `SquareDuplicateCharge`
  (reasons `SECOND_PAYMENT_ON_ORDER`, `AMOUNT_MISMATCH`), with the same audit entry and urgent
  alert; the winner's attempt, payment id and receipt are left alone. Several records may share
  one attempt. The link asks Square for no tips (`allow_tipping: false`).
- **A declined card on the hosted page does not end the link.** `FAILED` payments are
  recorded on the webhook row only; the payer can try again on the same page. Square does not
  promise ordered delivery, so an approval older than a decline already recorded for the same
  payment is ignored.
- **The setting is checked every time.** A replayed request on an event that has since turned
  the setting off withdraws the link, and the sweep withdraws every open link of such an event.
- **Deletions at Square never hold a request up.** After a request or webhook commits, the
  registration's withdrawn links are deleted fire-and-forget (failures logged and stored); the
  sweep owns the backlog.

**Square Checkout API semantics this uses** (no Square SDK is vendored here, so these
are from Square's published Checkout API and must be confirmed in Sandbox under #306
before Production is enabled):

- `POST /v2/online-checkout/payment-links` with `idempotency_key`, an `order`
  (`location_id`, `reference_id` = our attempt id, one line item for the exact amount),
  `checkout_options` (`redirect_url`, `allow_tipping: false`) and `payment_note`; the response gives
  `payment_link.id`, `order_id` and `url`. Nothing about the payer is sent.
- A payment link has **no expiry setting**. Expiry is this app's: a link lives 24 hours
  (`hostedLinkLifetimeMs`); an older one is refused on replay and withdrawn by the sweep.
- `DELETE /v2/online-checkout/payment-links/{id}` deletes the link and cancels its
  order, which is how a withdrawn link stops being payable at Square. A 404 counts as
  done. The delete is tried after commit and retried from the stored
  `INVALIDATED` + no `providerDeletedAt` state, so a Square outage never blocks recording
  a payment; a link that survives is still judged against the live balance when paid.
- No new webhook subscription: payment links produce ordinary `payment.*` events.

**Operations.** The scheduled outbox sweep (`/api/internal/outbox/sweep`, every few
minutes) also withdraws links that expired or went stale (a cancellation, a staff-recorded
payment, an adjustment) and retries deletions Square has not confirmed;
`npm run payments:hosted-sweep` runs the same housekeeping by hand. Sandbox evidence for #306: create a link on
a Sandbox registration, pay it with a Sandbox test card, confirm the webhook records it
once; create another, start an embedded payment, confirm the link is deleted; pay the
withdrawn page if Square still serves it and confirm the duplicate record and alert.
`npm run test:square-hosted-link` proves the same rules against a fake Square.

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
- `-- --auto-link` proposes every pair at once.

  It matches first on the **form submission number**. The external registration
  form writes `… - Submission #4259` onto the payment, and the WR26 import
  stored that same number on each registration as its FF Entry ID
  (`contactSnapshot.ffEntryId`). That is an exact key between the two systems
  and outranks names entirely. It is deliberately not narrowed by amount, so a
  submission whose money differs is reported as that — pointing at Finance —
  rather than falling through to a name guess.

  Only when a payment carries no submission number does it fall back to reading
  a person's name from the Square note — the same evidence a staff member reads
  off the receipt.
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

## Card payments taken at check-in

Check-in staff take door payments in the Square app on their phones. The
check-in roster and scanner show each owing registration's balance, the amount
to key into the Square app, and the confirmation code to type into the Square
payment note (`modules/payments/in-person-card.ts`).

- The card amount grosses the balance up by Square's **in-person** rate,
  2.6% + 15¢, approved for WR26. It is deliberately separate from the event's
  online card fee, which uses Square's online rate.
- Nothing is charged or recorded by IMSDA Events at the door. The payment lands
  in Square, and finance attaches it on **Payments → Unmatched Square
  payments**, which recognizes the confirmation code in the note.
- Events billed to an organization show no balance at check-in.
