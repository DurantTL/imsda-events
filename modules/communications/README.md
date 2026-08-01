# Communications module

Owns two separate event-scoped communication paths:

- Staff announcements with draft and published event-feed states.
- Versioned registration message templates, event sender/reply-to settings, transactional outbox rows, immutable rendered snapshots, reviewed balance-reminder batches, corrected-address confirmation copies, local or external delivery attempts, provider-event history, and audited staff retries.

## Registration message behavior

Public registration queues its registrant confirmation and one internal notice per configured internal recipient inside the same serializable transaction as the registration. The outbox uses a deterministic idempotency key, so an identical registration replay cannot create duplicate messages. Rendering uses an allow-listed plaintext token set; unknown tokens and multiline subjects are rejected when staff publish a new template version.

After the transaction commits, `LOCAL_CAPTURE` records a `CAPTURED` attempt without calling a provider. `EXTERNAL_EMAIL` claims rows for Resend with stable idempotency, stale-lock recovery, exponential backoff, and delivery-event reconciliation. `DISABLED` preserves a suppressed outbox row for auditing. Delivery failure never rolls a successful registration, lifecycle change, contact edit, or payment back.

The initial template set contains:

1. Paid/no-balance registration confirmation.
2. Unpaid/balance-due registration confirmation.
3. Worker confirmation.
4. Internal new-registration notice.
5. Waitlist entry.
6. Waitlist promotion.
7. Registration cancellation.
8. Contact-details update.
9. Square payment receipt.
10. Balance reminder.
11. Whole-registration transfer notice for the new contact.
12. Whole-registration transfer notice for the prior contact.
13. Attendee-substitution notice.

Staff can publish new immutable versions, inspect exact snapshots and delivery attempts, create a fictitious local test, process pending rows, and create an audited retry. Every generic retry requires a client UUID plus the server-issued SHA-256 fingerprint of the selected immutable source and current delivery mode. A lost-response replay with the exact pair returns the same child row; reusing the UUID for another source or fingerprint returns `IDEMPOTENCY_KEY_REUSED`. The retry transaction only snapshots and audits the child. Local capture or provider processing starts after commit.

Private management URLs are inserted in memory at delivery time from deterministic HMAC tokens; the raw bearer URL is never stored in the outbox, operation snapshots, audit metadata, API response, or logs. Transfer and substitution operations initialize their event's published template versions before mutation, queue the immutable rendered notices inside the business transaction, and process local or external delivery only after that transaction commits. The new transfer contact's replacement access row is also issued only after commit.

## Message bodies, HTML, and generated blocks

A template body is authored, validated, stored, and snapshotted as one plain-text Markdown source. Delivery sends that snapshot as the plain-text part and derives the HTML part from it at send time (`email-html.ts`), so the two parts can never drift and a captured row keeps meaning exactly what it said when it was captured. The renderer escapes the whole source before it looks for any markup, then recognises a small subset — headings, bold, italic, code, ordered and unordered lists, rules, images, and links restricted to `http`, `https`, `mailto`, and `tel`. Registrant-submitted values that reach a body through a token therefore cannot introduce a tag, an attribute, or a script.

Some sections depend on the event or on the registration's state rather than on the template. Those are server-generated blocks (`message-blocks.ts`), placed by a single token and emitted as Markdown like everything else:

- `{{hotel_information}}` — the event's configured lodging. Omitted entirely when the event has no hotel name, which is why lodging is per-event columns rather than text embedded in a shared template.
- `{{payment_status_block}}` — the paid, balance-due, complimentary, waitlisted, promoted, or cancelled section for this registration's actual state. The trigger decides the state, not the arithmetic: a waitlist confirmation with a nonzero total still says no payment is due.
- `{{checkin_block}}`, `{{checkin_qr_url}}`, `{{checkin_qr_image}}` — check-in instructions and the attendee pass QR, written against the delivery sentinels and omitted when the registration has no pass.

These tokens are optional: an empty value renders as nothing rather than leaving `{{token}}` in the body and stopping the send, and the surrounding blank lines close back up.

`{{contact_email}}` is the event organiser's published contact address — the one a "questions? contact …" line means. The registration's own destination is `{{registration_contact_email}}`, and `{{reply_to_email}}` remains the delivery header configured in message settings. The migration that introduced the split rewrote every stored template version from the old `{{contact_email}}` to `{{registration_contact_email}}`, so an already-published template kept rendering exactly the value it rendered before.

Preview in the workspace renders the same HTML delivery sends, inside a fully sandboxed iframe, with the delivery sentinels replaced by valid but obviously non-live URLs. It uses the one sample context the server also uses, rather than a second copy: the copies had drifted, and the preview was pairing one event's dates and venue with another event's lodging.

## Balance-reminder workflow

The Reminders tab is a two-step staff workflow. Its read-only preview considers every event registration, but includes a recipient only when all three rules are true:

1. The registration status is `SUBMITTED` or `CONFIRMED`.
2. Registration total minus successful payments plus successful refunds is greater than zero.
3. The registration contact snapshot (falling back to the account holder) contains a valid email.

The preview shows included and skipped counts, one mutually exclusive skip reason per omitted registration, the total outstanding balance, and every destination row. Its SHA-256 fingerprint covers the recipient rows, balances, skip counts, published template version, template enabled state, sender snapshots, delivery mode, and event text used for rendering.

Creating a batch requires that exact fingerprint plus a client-generated UUID. The server recomputes new batches in a serializable transaction and returns `409` if anything changed. Each outbox row is idempotent on event, batch UUID, and registration. A lost-response retry reads the audited batch before recalculation: the same UUID and fingerprint returns the original operation, while the same UUID with a different fingerprint is rejected. One audit row is protected by a partial unique index.

- `DISABLED` records suppressed rows and never sends.
- `LOCAL_CAPTURE` captures rendered local attempts and never contacts Resend.
- `EXTERNAL_EMAIL` creates pending rows only. Staff must separately use **Process email queue** before any provider call.

## Confirmation-copy workflow

An original terminal registrant confirmation can be copied from the Delivery log. Staff may enter a validated corrected email for that copy only. The source subject, body, sender, reply-to, registration link sentinel, and template-version reference are copied unchanged; neither `Person` nor the registration contact snapshot is updated.

The action requires a client UUID. Repeating that UUID returns the previously stored destination and row. Corrected confirmation copies and generic staff retries share one database-enforced active-child invariant: a second action is rejected while any child of the same source is `PENDING` or `PROCESSING`. A later intentional copy is allowed after the prior child reaches a terminal state. Local mode captures only, disabled mode suppresses, and external mode queues without automatically processing.

## Current boundary

Resend is the only external provider adapter and remains disabled until credentials and an event sender address are configured. SMS, push, targeted/scheduled announcement delivery, preferences, and unsubscribe handling remain future work.
