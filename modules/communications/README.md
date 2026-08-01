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

A template body is authored, validated, and stored as one plain-text Markdown source. Both parts of the message are rendered from that source and the same token context in one `renderMessageTemplate` call and snapshotted together on the outbox row (`bodyTextSnapshot`, `bodyHtmlSnapshot`), so the two parts cannot drift and a captured row keeps meaning exactly what it said when it was captured. Delivery wraps the stored fragment in the email layout; it does not re-render it. Rows queued before HTML bodies existed have no fragment and go out as text only.

Two separate protections apply, because they answer different attacks. First, the renderer escapes the whole source before it looks for any markup, then recognises a small subset — headings, bold, italic, code, ordered and unordered lists, rules, images, and links restricted to `http`, `https`, `mailto`, and `tel` — so nothing in a body can introduce a tag, an attribute, or a script.

Second, HTML escaping alone does not stop *Markdown* injection: a registrant named `[Review your registration](https://malicious.example)` would otherwise get a trusted-looking link, and `![](…)` a tracking pixel, into mail sent from the IMSDA address. So untrusted token values are Markdown-escaped before substitution, and only `MARKDOWN_MESSAGE_TEMPLATE_TOKENS` — the generated blocks, the URL tokens that sit inside `[text](…)`, and the staff-authored `announcement_body` — carry live Markdown. `attendee_summary` is deliberately not in that set: it is built from registrant names and submitted answers, so it renders as plain lines rather than a list. The escapes are dropped again while rendering, and the plain-text part substitutes the raw value, so no reader ever sees a backslash.

This is also why the HTML is rendered at enqueue rather than at delivery. Only there are the trusted and untrusted spans of a body still distinguishable; the finished text cannot tell a template's Markdown from a registrant's.

Rendering at enqueue has one consequence worth knowing before touching `email-html.ts`: a body is rendered *before* any private token exists, so its portal link and pass image carry the delivery sentinels rather than URLs. The renderer accepts those as a third, internal URL class, matched by exact shape rather than by prefix. If it did not, scheme validation would reject them, and a rejected link is rendered as inert text — which strips the `href` and `src` and leaves delivery nothing to substitute, so every HTML email loses its buttons and its QR while the plain-text part still looks correct. `tests/delivery-sentinel-round-trip.test.ts` pins that whole path, because preview tests use ordinary HTTPS sample URLs and never exercise it.

Some sections depend on the event or on the registration's state rather than on the template. Those are server-generated blocks (`message-blocks.ts`), placed by a single token and emitted as Markdown like everything else:

- `{{hotel_information}}` — the event's configured lodging. Omitted entirely when the event has no hotel name, which is why lodging is per-event columns rather than text embedded in a shared template.
- `{{payment_status_block}}` — the paid, balance-due, complimentary, waitlisted, promoted, or cancelled section for this registration's actual state. The trigger decides the state, not the arithmetic: a waitlist confirmation with a nonzero total still says no payment is due.
- `{{checkin_block}}`, `{{checkin_qr_url}}`, `{{checkin_qr_image}}` — check-in instructions and the attendee pass QR, written against the delivery sentinels. A pass resolves one attendee, so a QR is inlined only for a single-attendee registration; a party is sent to the portal, where each attendee has their own labelled pass. Inlining the first attendee's code for a family would check that person in and leave the rest holding a code that is not theirs.

These tokens are optional: an empty value renders as nothing rather than leaving `{{token}}` in the body and stopping the send, and the surrounding blank lines close back up.

`{{contact_email}}` is the event organiser's published contact address — the one a "questions? contact …" line means. The registration's own destination is `{{registration_contact_email}}`, and `{{reply_to_email}}` remains the delivery header configured in message settings. The migration that introduced the split rewrote every stored template version from the old `{{contact_email}}` to `{{registration_contact_email}}`, so an already-published template kept rendering exactly the value it rendered before. Because the parser trims arbitrary whitespace inside the braces, that rewrite is a regular expression rather than a literal replacement: `{{ contact_email}}` and `{{contact_email  }}` are equally valid spellings staff may have saved, and a missed one would have silently changed meaning at deploy.

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
