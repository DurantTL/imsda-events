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

## Checking in a whole club at once (Q1, #412)

Staff find a club by confirmation code or club name in the arrival roster's
search, or by scanning any member's QR pass or the confirmation code — both
paths open the same club view (`components/club-check-in-panel.tsx`), listing
every attendee with the amount estimated billed to the church
(`modules/club-registrations/church-owed.ts`, read-only, never a door
payment) and any flags, including a missing Sterling Volunteers record (#405/#388).
Only an active (submitted or confirmed) club registration is offered, the
same eligibility single-attendee check-in already enforces
(`modules/club-registrations/repository.ts`'s `listClubCheckInInfo`); a
waitlisted or cancelled club is not checked in here.

**Check in all** and **Check in selected** call the exact same per-attendee
`checkInAttendee` path as a single row's check-in, one attendee at a time
through the same offline queue — never a bulk endpoint — so each person gets
their own check-in record and undo, idempotent retries, and reports behave
identically. Someone already checked in (by this device, another scan, or
another staff member) is skipped rather than re-sent, so repeats never
duplicate or error. Both club views run the same loop,
`checkInSequentially` in `modules/checkin/bulk-check-in.ts`: one attendee at
a time, a failure for one person is recorded as needing review and the loop
carries on, progress is announced ("Checking in 12 of 40…"), and the summary
names who needs review. A saved check-in already held for review (queue state
`CONFLICT`) is left out of **Check in all**; staff retry it on purpose by
ticking it for **Check in selected** or with its own retry. Unreadable saved
queue data disables the club view in both places.

Scanning one member's own QR pass returns the club roster plus
`scannedAttendeeId`. The scanner highlights that person and makes "Check in
<name>" the primary action; the whole club sits behind an explicit "Open
whole club" disclosure, so one late child's pass can't record the whole club
as arrived. A confirmation-code lookup has no scanned person and opens the
plain club view. Campsite and assignments don't exist yet (#410); the club
view leaves that slot clearly empty instead of inventing that schema.

### The club's own QR (Q1, #412)

Clubs don't get individual per-member QR codes beyond what already exists;
instead a director can show one QR (`club-pass-token.ts`,
`club-pass-repository.ts`) that opens the plain club view directly — the
same view a confirmation-code lookup or a member's own pass opens, with no
scanned person. It is event-scoped, signed with the same secret mechanism
and 48-hours-after-event expiry as an attendee pass, but is a structurally
distinct token: a different top-level prefix (`imsda-club-pass.v1…`), a
different HMAC namespace, and its own `type` field in the signed payload, so
an attendee pass and a club pass can never be mistaken for one another even
though both verify against `ATTENDEE_PASS_SIGNING_SECRET`. The scan/lookup
route (`pass-lookup.ts`) tells the two apart by token prefix before either
is verified. Only an active (submitted or confirmed) club registration gets
a working pass; a director reaches only her own club's QR
(`requireRosterAccess`, the same gate the club event page already uses).

### Several devices at one desk (#825)

A desk runs 2-4 phones or tablets, often on one staff account, on cellular or
venue Wi-Fi.

- **Check-in** (`repository.ts`): serializable transaction plus the partial
  unique index on active rows. A lost race retries (up to
  `CHECK_IN_MAX_ATTEMPTS`, with a short jittered pause) and then answers
  `ALREADY_CHECKED_IN` with `checkedInBy` (the staff display name from the audit
  entry written in the same transaction). The same retry key returns the same
  record (`IDEMPOTENT_REPLAY`). **Undo** only matches a row that is still
  active, so two undos make one audit entry and the loser gets
  `ACTIVE_CHECK_IN_NOT_FOUND`, which the UI treats as done.
- **Live list**: `GET /api/events/[eventId]/check-ins?since=` returns
  `[attendeeId, checkedInAt|null]` pairs (`live-changes.ts`), polled every 5 s
  by a visible tab with backoff, a 15 s overlap, and a 6 h look-back cap. A quiet
  answer is under 80 bytes. Rows this device just touched are not overwritten.
- **Slow networks**: requests time out after 12 s and stay in the saved queue
  with their key; unconfirmed items retry every 20 s while online. Rows read
  "Not saved - tap to retry" or "Retrying...".
- **Limits**: the staff scan, lookup, check-in, undo, staff pass image and live
  poll routes carry no rate limiter (authenticated and permission checked).
  Sign-in and attendee pass budgets are sized in `modules/rate-limit/service.ts`
  (`staffLoginBudgets`, `publicManageBudgets`); the per-IP numbers allow for
  carrier-grade NAT and venue Wi-Fi.
- **Sessions**: sign-in only adds a session; nothing is tied to the client IP;
  up to `MAX_LIVE_CHALLENGES` second-step challenges per account may be open
  at once. A 6-digit authenticator code is single-use, but a correct code that
  was already spent (several phones reading the same code within one 30 s
  step) is not a wrong guess: it answers `MFA_CODE_ALREADY_USED` ("That code
  was just used on another device. Wait for the next code, then enter it."),
  releases the reserved attempt, sends no lockout email and leaves the
  challenge live. Wrong codes still count and still lock after 3. Volunteers
  just wait for the next code; no recovery codes need handing out. The
  per-challenge attempt cap (5) and the sign-in rate limit still bound it.
