# IMSDA Events build status and WR26 feature audit

Updated July 29, 2026. This document compares the current IMSDA Events workspace with the useful behaviors in [DurantTL/WR26-IMSDA](https://github.com/DurantTL/WR26-IMSDA). WR26 is a behavior reference, not an architecture to copy: IMSDA Events remains the multi-event PostgreSQL system of record rather than importing the old WordPress, Google Apps Script, Google Sheets, or in-memory-cache architecture.

## July 29 Women’s Retreat implementation update

The repository now includes the first complete attendee event-day surface:

- An authenticated retreat hub for active registrations with published event
  content, staff updates, current program assignments, check-in state, support
  details, resources, and one private QR pass per attendee.
- An event-scoped, read-only staff switch into the attendee experience. It
  shows the selected event's shared published content and Community placeholder
  without requiring a second account or exposing a registrant's personal
  registration, assignments, balances, or QR passes.
- Audited global team profiles. A system administrator can correct a team
  member's display name and record their title/responsibility, phone, and
  internal profile notes from System Management → Team; the event team view
  shows those details without creating a competing event-specific profile.
- Women’s Retreat primary-contact name syncing. The first attendee starts with
  the name of the person completing the form and follows contact-name edits
  until the attendee name is deliberately changed. The primary contact remains
  the saved registration/account holder if attendee one is someone else.
- Searchable dropdowns across public registration, builder preview, and
  attendee self-service editing. Long church and club directories can be
  filtered by typing while remaining keyboard accessible.
- Faster form creation with module search/category filters, one-click field
  copying, a ready-to-use searchable church-directory module, section-size
  safeguards, and clearer module discovery.
- Tiered account editing for low-risk structured attendee answers such as meal,
  shirt, volunteer, and session choices. Identity, demographic, medical,
  accessibility, priced, capacity-controlled, and protected conditional fields
  remain staff-managed.
- A retreat-guide starter in the event-page editor for schedule, arrival,
  parking/check-in, meals/childcare/accessibility, packing, and resources. Every
  section remains unpublished until staff deliberately publishes it.
- Childcare, volunteer, and optional-session attendance reports and CSV
  downloads, in addition to roster, meals, housing, and seminar reports. Reports
  prefer the current amended attendee answers rather than the immutable original
  submission snapshot.
- A separately confirmed email-broadcast action for a published announcement,
  using the event’s versioned template, active registration audience, configured
  delivery mode, outbox processing, idempotency, and audit log. Publishing to
  the feed alone still never sends email.

Repository verification is green: lint, generated route types, TypeScript, all
tests, and the Next.js production build. Deployment still requires migration
44, a controlled data/configuration check against the deployed environment, and
the Square Sandbox rehearsal described below.

## What is working locally

| Area | Current capability |
| --- | --- |
| Staff access | Password login, database sessions, password recovery, event-scoped roles/permissions, staff activation safeguards, audited global names/profile details, and durable hash-only rate limits |
| Multi-event operations | Event creation/settings, publishing readiness, public event pages, website embed code, event selector, database-derived overview, and event-scoped authorization |
| People and registrations | Registration CRUD, ordered attendee parties, public individual/household/group submission, immutable answer review, explicit cancel/reactivate/waitlist/promote actions, automatic promotion, staff-only whole-registration transfer and in-place attendee substitution, balances, and CSV export |
| Finance | Manual cash/check payments, partial offline refunds, bounded event promo codes, Square Sandbox checkout, durable payment attempts, signed payment/refund webhooks, balance calculation, and audit records |
| Check-in | Attendee search, individual check-in/online undo, signed PII-free QR passes, camera/manual resolution, visible staff confirmation, and a recoverable device-local offline check-in queue |
| Communications | Announcement drafts/publication with public and authenticated feeds, explicitly confirmed email broadcasts, event sender settings, fifteen versioned event templates, transactional outbox, transfer/substitution notices, exact-audience balance-reminder preview/batches, corrected-address immutable confirmation copies, local capture or Resend delivery, provider-event history, retry/backoff, audited retry, and corrected-copy recovery for legacy failures whose sender snapshot was blank |
| Imports | CSV preview, validation, matching, reviewed commit, reconciliation totals, exception export |
| Form builder | Seven templates, searchable/category-filtered reusable modules, field copying, individual/group mode, repeatable attendee preview, sections/fields, drag and button reordering, validation tests, immutable publication and version history |
| Conditions | One show/hide rule per field with equals, not-equals, includes, and has-answer operators; hidden required fields and hidden prices are skipped |
| Pricing | Automatic fees, flat prices, quantity prices, per-choice prices, bounded fixed/percentage promo discounts, card-fee gross-up after discount, and date-driven standard/late prices |
| Public registration | IMSDA-branded landing/form/embed views, published all-attendee event updates, multi-step add/remove/reorder roster flow, searchable dropdowns, first-attendee/primary-contact name syncing with an editable override, explicit promo Apply/Remove quotes, server validation/timezone pricing, immutable answer/order/redemption snapshots, waitlist routing, confirmation delivery, and private management link |
| Private self-service | Hash-only expiring/revocable bearer links plus verified attendee accounts, no-store/noindex responses, contact edits, tiered low-risk attendee-answer edits, private event hub/QR passes, attendee/status/payment history, secure Square handoff, and a non-impersonating staff preview of shared attendee content |
| Availability | Event capacity, per-choice limits, registration/attendee reservations, ranked first/second counts, within-roster aggregation, serializable concurrency protection, cancellation release/reactivation, waitlist position, and automatic promotion |
| Security | Same-origin mutations, strict public schemas, CSP and embed allow-list, hash-only sessions/reset/manage/rate-limit identifiers, trusted-proxy controls, provider signature verification, and production safety locks |

## Important scope boundaries

- Builder-preview counts come from valid fictitious **test submissions**; the public form separately shows committed reservation counts.
- Publishing activates `/events/{event-slug}`, `/register/{event-slug}/{form-slug}`, and the noindex `/embed/{event-slug}/{form-slug}` view.
- Public submission recomputes pricing, conditions, capacity, and waitlist eligibility server-side. A waitlist request records no payment choice or card fee. After promotion, its private page requires an explicit card or pay-later choice, shows both totals, and adds the configured gross-up exactly once from the preserved discounted subtotal before Square hosted fields can load.
- Square and Resend are implemented but disabled with blank local credentials. Square remains Sandbox by default and Production requires a separate explicit unlock.
- Private self-service permits contact edits and tiered low-risk structured
  attendee-answer edits. Whole-registration transfer, attendee substitution,
  identity/demographic/medical/priced/capacity-controlled changes, cancellation,
  and refunds remain staff-mediated.
- Lifecycle messages cover waitlist entry/promotion, cancellation, contact updates, whole-registration transfer, attendee substitution, and first-success Square payment receipts. Reviewed balance-reminder batches and corrected-address confirmation copies are complete.
- Published, already-active announcements whose audience is exactly all
  attendees appear on the public event landing page and authenticated retreat
  hub. Staff may explicitly broadcast one published announcement to active
  registration contacts. Scheduled/segmented delivery, SMS, push, preferences,
  and attendee-to-attendee discussion are not complete.
- File uploads, seminar assignment runs and rosters, event content, and core
  operational reports are complete. Dedicated print layouts for passes/group
  packets and an attendee discussion board with reporting/moderation remain open.
  Payment and undo actions are intentionally never added to the offline check-in
  queue.

## WR26 behaviors to preserve in the new platform

### Registration and self-service

- Public individual, household/group, and worker registration paths
- Repeatable attendee roster with attendee-specific meals, dietary needs, childcare, and seminar choices
- Secure magic-link portal for viewing and editing a registration
- Whole-registration transfer and in-place attendee substitution. **Complete.**
- Registration close date distinct from early, standard, and late price dates
- Promo codes with type, amount, expiry, minimum purchase, and maximum uses

### Capacity and event programs

- Transactional event and inventory capacity checks
- Ordered waitlist with promotion and removal workflows
- Ranked seminar choice collection, assignment preview/run, capacities, and rosters
- Printable church/group rosters and operational meal counts
- Worker/non-paying attendees included in operational counts but excluded from paid capacity and reminders where configured

### Confirmation emails and notifications

The WR26 repository demonstrates several separate message types that should become configurable multi-event templates:

1. Paid and unpaid registration confirmations with attendee summary, balance, QR pass, and secure portal/payment link.
2. Internal registration notification or BCC recipients.
3. Confirmation after a registrant edits a registration.
4. Waitlist entry, promotion, and removal messages.
5. Transfer notices to the new registration contact, prior contact, and affected attendees as appropriate. **Complete.**
6. Worker confirmation.
7. Pending-balance reminder with preview/dry-run before send. **Complete.**
8. Staff resend of a confirmation, including an optional corrected recipient address. **Complete.**

IMSDA Events implements the shared versioned-template, outbox, idempotency, retry/backoff, delivery/suppression log, preview/test, and event sender/reply-to foundation. Generic staff retries use a stable client UUID plus an immutable-source fingerprint, replay the same child after a lost response, and share the corrected-resend active-child database invariant. When a legacy failed row has no sender snapshot, staff can create a separately audited corrected copy that preserves the original subject and body while taking the event's current sender; the failed source row remains immutable. Email failure does not roll back a successful registration or payment. Remaining message-specific work is called out below.

### Payments

- Square Sandbox checkout with Web Payments SDK tokenization
- Server-authoritative quote and immutable order-item snapshot
- Payment-attempt and idempotency records
- Signature-verified, idempotent webhook processing
- Pay-later balance links and payment reminders
- Refund and reconciliation states visible to finance staff

### Event-day operations

- Signed PII-free attendee QR generation, private self-service display, and authorized camera/manual scanning with staff confirmation (complete)
- Recoverable check-in queue with explicit conflict handling (complete); payment actions remain online-only by design
- Printable passes and rosters
- Operational notification center for failed payments, capacity warnings, unsent messages, import exceptions, and sync failures

## Behaviors not to copy from WR26

- Google Sheets or Apps Script as the source of truth
- Hard-coded Women’s Retreat email HTML or event-specific field names in shared services
- An in-memory operational cache as authoritative state
- Continuing the regular price forever after the final deadline
- Creating a zero-dollar registration during waitlist promotion
- Enabling Square Production by default

## Recommended build order

| Priority | Build | Acceptance gate |
| --- | --- | --- |
| Complete | Public form renderer and submission transaction | Submission references an immutable form version; hidden answers are stripped; amount, conditions, and event-local date are recomputed server-side |
| Complete | Capacity-safe public submission | Concurrent submissions use serializable transactions and normalized reservation rows; the one-final-slot test yields one success and one conflict |
| Complete | Confirmation message foundation | Thirteen versioned templates, event settings, local preview/test, transactional outbox, local/Resend delivery, provider events, backoff, retry, and delivery logs |
| Complete | Reviewed balance reminders and confirmation copies | Exact fingerprinted audience preview, per-batch/registration idempotency, no-send enqueue boundary, corrected one-time destination, immutable source copy, concurrency guard, and audit history |
| Complete | Repeatable attendee rosters | Household/group registration creates the configured number of attendee-scoped response sets, attendees, prices, capacity claims, message summaries, and staff-review snapshots |
| Complete | Registration lifecycle and waitlist | Open/close dates, cancellation release/reactivation, waitlist order/automatic promotion, audits, and notices |
| Complete | Square Sandbox checkout | Hosted tokenization, server balance, durable attempts, receipts, signed/deduplicated payment and refund webhooks |
| Complete | Private self-service | Registrant can securely view the exact registration, update contact details, see balance/history, and continue card payment |
| Complete | Signed event-day passes | One private pass per eligible attendee, HMAC verification, event-scoped camera/manual lookup, and explicit staff confirmation before check-in |
| Complete | Recoverable offline check-in | Client UUID idempotency, one-active-check-in database invariant, queued-not-confirmed UI, reconnect retry, and explicit Retry/Discard conflict recovery |
| 1 | Remaining event-day foundation | Dedicated print layouts for pass sheets and grouped retreat packets |
| Complete | Bounded promo codes | Finance managers configure fixed/percentage codes with event-local dates, minimums, use limits, immutable redemptions, public Apply/Remove quote, and concurrent final-use protection |
| Complete | Transfer workflow | Two-step staff review, whole-registration transfer, in-place attendee substitution, durable idempotency, immutable operation snapshots, access revocation/reissue, and versioned notices |
| Complete | Program operations | Ranked assignment preview/run and rosters plus meal, housing, seminar, childcare, volunteer, and attendance reports |
| 3 | Attendee community expansion | Opt-in attendee posts, staff moderation/reporting, conduct copy, retention policy, and notification controls |
| 4 | Communications expansion | Targeted/scheduled announcements, SMS/push adapters, preferences, unsubscribe, and urgent alerts |

## Repository delivery status

The project is committed and connected to its GitHub repository `DurantTL/imsda-events`. CI runs under `.github/workflows/ci.yml` on pushes to `main` and on pull requests (PostgreSQL service, migrate, seed, then `npm run verify`). Configure branch protection on `main` to require the `verify` check before merge.
