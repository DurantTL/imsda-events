# Check-in module

Owns event-scoped arrival records, signed attendee passes, and reversible
check-in history.

Each attendee pass is a stateless HMAC-SHA256 token containing only the event
ID, attendee ID, format version, and expiry. Names, email addresses, phone
numbers, confirmation codes, and payment details are never encoded. Staff must
be signed in with `MANAGE_CHECK_IN` for the selected event before a QR token or
manual registration confirmation code can resolve to attendee details. A scan
only opens a visible review step; it never checks someone in automatically.

`ATTENDEE_PASS_SIGNING_SECRET` must be a unique random value of at least 32
characters in production. During rotation, move the old value to
`ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS` and keep it there until its last pass
expires. Passes expire 48 hours after the event ends, and current registration
eligibility is checked again at scan time, so cancellation or waitlisting takes
effect immediately without a revocation table.

The private management page can render one no-store QR image per eligible
attendee only through its existing expiring registration access token. QR and
pass lookup responses are private, no-store, and noindex.

Authorized check-in staff can also open **Print attendee passes** from the
arrival workspace. The print sheet contains one card for every attendee on an
active submitted or confirmed registration, sorted by attendee name. Each QR
image is rendered through a separate event-scoped `MANAGE_CHECK_IN` request;
the batch page does not place bearer tokens in HTML or browser storage. Printed
names and confirmation codes are human-readable fallbacks outside the signed
QR payload. The browser print stylesheet produces two privacy-conscious cards
per row and the page stops offering expired passes 48 hours after event end.

## Recoverable offline check-in

Every attendee check-in begins by saving a strict client UUID and the opaque
attendee ID in an event-scoped browser queue. The queue does not persist names,
email addresses, phone numbers, confirmation codes, pass tokens, form answers,
or payment data. A successful response removes the saved retry; a lost response
can reuse the same UUID and receive the original operation instead of creating
a duplicate audit record.

The database retains reversible history but uses the migration-level partial
unique index `CheckIn_registrationAttendeeId_active_key` to permit at most one
check-in with `undoneAt IS NULL` per attendee. Serializable retries resolve a
concurrent double check-in to the winning active record.

When the page is offline or a request fails, the attendee is labelled
**Queued — not confirmed**. Queued network failures retry automatically when
the browser reconnects. Missing attendees, ineligible registrations, reused
keys, reversed operations, expired staff sessions, and other server rejections
remain visible as conflicts with explicit **Retry** and **Discard** controls.
Discard only removes that device's saved retry; it never undoes server state.

Only the `CHECK_IN` action uses this queue. Undo remains an explicit online-only
mutation, and payment actions are never queued. The implementation does not
install a service worker or cache authenticated pages.
