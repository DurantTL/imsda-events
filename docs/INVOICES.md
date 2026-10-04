# Invoices: drafts, finalization, revisions, delivery and statements (#167 slice 3, #168 slice 4)

For events billed to organizations after the event (`DEFERRED_ORGANIZATION_INVOICE`, such as Spring
Camporee). It turns the approved attendance reconciliation (#166) and the recorded billing
responsibility (#165) into one invoice per church or club, reviewed by a person and then finalized by a
named person with permission. Decisions: ADR 0008 and Caleb's Oct 4, 2026 answers on the issue.

**Nothing is sent by finalizing.** Finalizing assigns a number and freezes the invoice; it does not email, print or
notify anyone, and the church and club director see nothing until conference staff send it (see "Delivery, AR,
payments and statements" below, #168). There is no automatic finalization, no automatic send, no scheduled job and no reminder.

The screens are Finance, then Invoices (`/finance/invoices`) and one invoice
(`/finance/invoices/[invoiceId]`), linked from the Finance page and from Attendance reconciliation. Only
MANAGE_FINANCE on the event can open them or use their actions; every action checks again on the server
and refuses any invoice or version outside the event in the URL (404).

## Who can do what

| Action | Needs |
| --- | --- |
| View invoices, create drafts, regenerate a draft, start a revision, set the event's invoice code | MANAGE_FINANCE on the event |
| Finalize an original invoice, or a revision that changes any billable amount | MANAGE_FINANCE **and** the Finalize invoices permission |
| Finalize a revision that changes only the billing contact | MANAGE_FINANCE |
| Grant or remove the Finalize invoices permission | System administrator only |

**Finalize invoices** (`FINALIZE_INVOICES`) is its own permission. System administrators have it
everywhere; no role carries it, Event Admin and Finance Manager included, so having MANAGE_FINANCE or
running the event does not include it. It is a grant on a staff assignment, set by a system administrator
on the staff page (Event access, "Give permission to finalize invoices"), the same model as the health
information permission (#658). Each grant and removal is audited with who, whom and the event. It is
removed automatically when the assignment is deactivated, re-added or its role changes, so only a system
administrator grants it again. It can be granted only to an active assignment whose role includes
finance access (Finance Manager or Event Admin), since finalizing needs both; otherwise the grant is
refused with that explanation. Grants and removals lock the membership row while permissions are read
and written, so a concurrent change to another permission (such as health access) is never undone.

**Why per event, not conference-wide.** The platform has no conference-level grant table: every
permission besides `globalRole` lives on an event membership, and the audit, the staff screen and the
session checks are built around that. A person who finalizes for several events (the treasurer) is given
the permission on each, which keeps every grant visible on the event it covers and needs no new
authorization model. If the conference later wants one grant for all events, it is a new global flag
checked in `effectivePermissions`; nothing else here would change.

The permission is read where the request comes in, and the service enforces it again against the
amounts: a revision is compared with the finalized version it replaces by an **amounts fingerprint** (every
line, credit, promo, charge and the total; not names, labels or contacts). Same fingerprint means no
billable amount changed, so finance staff may finalize it; any difference needs the permission. The
caller cannot set that by a flag.

## Drafts

"Create invoice drafts" builds one draft per invoice group of the event's **approved** reconciliation.
It is refused with a plain reason when:

- no reconciliation is approved (a prepared draft is not enough);
- the approved reconciliation's freshness is **FACTS_CHANGED** (attendance, corrections or billing facts
  moved since the approval: prepare and approve again);
- billing responsibility has blockers (a billed registration is unrecorded, out of date or unresolved,
  #165; an unresolved registration can never be invoiced);
- invoices that already have a number were finalized under a different invoice grouping than the
  approved reconciliation uses (change the setting back, or revise under the old one). Invoices that
  have no number yet are not a problem: they follow the event's current grouping, and drafting under a
  new grouping re-points them. Because a church's or person's group key is the same under both
  groupings, such an invoice is reused; a draft made before the setting changed is refused at
  finalization (`DRAFT_STALE`) until the drafts are created again from the re-approved reconciliation.

The groups are the #165 groups for the event's setting: one invoice per church (its clubs are lines of
that invoice) or one per club, each addressed to the church's billing contact. A group nobody attended is
a $0 draft. A draft traces to the approved reconciliation version and, through it, to the source
registrations; the same version is linked on every finalized version.

**What a draft snapshots** (in the version row and its `snapshot`, from the approved reconciliation,
which is itself immutable): the event, the organization or person billed, the active billing contact at
that moment (name, email, role, verified), the reconciliation version and rule version, one line per
registration with registered, checked-in, no-show and billable counts, each person's amount (billable
people only; "prorated" when the registration was prorated), charges not tied to a person, credits such as
meal sponsorship, the promo code, staff adjustments, and the totals. Attendee names are in the snapshot
because the invoice lists who was billed; it holds no phone number, health or payment detail.

**Regenerating** replaces a DRAFT only, never a finalized version. Creating drafts again with nothing
changed writes nothing; if the approved reconciliation, an amount or the contact moved, the draft is
rebuilt (the version records how many times). A draft's only edits are regeneration; a database trigger
refuses any other change. **Discarding** (MANAGE_FINANCE, audited) throws away an open draft or an
unfinalized revision: it becomes DISCARDED, stays on record, and is hidden from the list and the draft
counts; creating drafts again makes a fresh one (a discarded revision frees its revision number). A
finalized version cannot be discarded. A finalized invoice found no longer matching the approved reconciliation is not
touched: the screen flags it and offers a revision.

## Finalizing

Finalizing is deliberate: the page shows a confirmation naming the person, the group and the total
("I, Tess Treasurer, approve this invoice for Church One totaling $100.00..."), and the request must carry
`confirm: true`, the signed-in user is the approver (their name is saved on the invoice even if the account
is later deleted), and the request carries an **idempotency key**. In one transaction, under the event's
lock, it:

1. checks the draft is still current: for an original or an amount-changing revision, the approved
   reconciliation is the one the draft was built on, is not FACTS_CHANGED, billing responsibility has no
   blockers, and the amounts rebuilt from it equal the draft's; for every version, the billing contact is
   still the contact on the draft (a changed contact means regenerate) and exists (a finalized invoice
   needs someone to be addressed to; an unverified contact is allowed and shown as unverified);
2. assigns the number (below) exactly once;
3. marks the version it revises SUPERSEDED and its receivable SUPERSEDED (revisions only);
4. freezes the draft with a compare-and-set DRAFT to FINALIZED, recording the approver, the time and the
   key; losing the compare-and-set rolls everything back, including the number;
5. records the receivable;
6. writes an audit row (ids, the number and amounts; never a contact's name or email).

A $0 invoice can be finalized: it gets a number and a $0 receivable, so the group has a record that
nothing is owed. (There is no void; see "Not built".)

### Numbers

`<EVENTCODE><YY>-<NNNN>`, for example `SC27-0001`; revisions add `-R1`, `-R2` to the same base. The year
is the year the event starts in its own time zone, not the day the invoice is finalized.

- **Event code.** The events table has no short code, so staff may set one (letters only, two to six,
  on the Invoices screen, MANAGE_FINANCE, audited); otherwise it is the initials of the words of the name
  that start with a letter, uppercase, at most four ("Spring Camporee 2027" is `SC`; a one-word name uses its
  first three letters; none at all is `EV`). The first finalization **freezes** the code on the event (a
  later rename cannot start a second series) and a trigger refuses any change after a number was issued.
- **Counter.** One row per (code, year) in `InvoiceNumberCounter`, taken by a single
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the finalize transaction. Concurrent finalizations
  serialize on that row, a rolled-back finalization gives its number back (no gaps), and the counter only
  counts up by one (trigger). The row also records its event: two events can never share a series, so a
  number is unique everywhere. If a second event would clash (same code and year), finalization is refused
  and staff set a different code first (`CODE_IN_USE`); setting a clashing code is refused up front too.
- **Per event and year.** Numbers count per event and per year: a new year (the event start moved to the
  next year) starts again at 0001.

### Retries and concurrency

One lock per event (the advisory lock the reconciliation also takes) serializes drafting, revising,
finalizing, preparing and approving, so a finalization always sees the approval it relies on. On top of it
the database enforces: one open draft and one live finalized version per invoice (unique partial
indexes), one number per invoice (trigger), a counter that only counts up, one receivable per finalized
version (unique), and one OPEN receivable per invoice.

- A second request for a version that is already finalized (a retry with the same key, a double click, two
  staff at once with different keys) **returns the same number and changes nothing**.
- A key may not be reused for a different version (`IDEMPOTENCY_KEY_REUSED`).
- Two invoices finalized at the same time take 0001 and 0002; neither number is issued twice.

## Revisions

A correction after finalization is a new **version** of the same invoice, linked to the version it
revises; the finalized version is never rewritten and stays fully readable in the history.

- "Start a revision" (MANAGE_FINANCE, a reason is required) is allowed on a finalized invoice with no open
  draft. Two kinds:
  - **Contact only**: copies the finalized lines and amounts unchanged and refreshes the billing contact.
    Refused if the contact has not changed. Finance staff can finalize it.
  - **Rebuild from the approved reconciliation**: an adjustment after finalization (a correction or a
    new check-in, reconciliation re-approved). Refused if the amounts and the contact are the same. Needs the
    approved, current reconciliation like a draft. If the group is no longer in the approved
    reconciliation, the revision brings the invoice to $0. It needs the Finalize invoices permission to
    finalize if any billable amount differs (ADR 0008 section 4).
- The revision's number is the base number plus `-R<n>` (`SC27-0001-R1`), assigned when it is finalized.
  The counter is not touched.
- Finalizing it marks the prior version SUPERSEDED (recording what replaced it) and its receivable
  SUPERSEDED; the prior version and its number stay readable and immutable.
- One open revision per invoice. A draft or revision can be regenerated; a contact-only draft is copied
  again with the contact as it is now.

**A billing contact changed after finalization.** The finalized snapshot keeps the contact it was
finalized with. The list and the invoice show "Contact changed since finalization" and offer a
contact-only revision. The same screens flag "No longer matches the approved reconciliation" when the
amounts moved.

## The receivable (now) and the ledger (later)

Caleb's decision: each finalized invoice version records its own receivable now; the ledger
(#117-#120) links in when it lands. `InvoiceReceivable` has one row per finalized version, created in the
finalization transaction, for exactly that version's `amountDueCents` (a trigger refuses any other
amount), status `OPEN`, becoming `SUPERSEDED` when a revision is finalized. The amount owed on an invoice
is its single OPEN receivable. It is not a payment record: payments, refunds and adjustments stay in the
existing Payment, Refund and RegistrationAdjustment records (ADR 0008, ledger basis).

**How it moves onto the ledger.** The receivable's `invoiceVersionId` is the stable reference. A ledger
migration would post one receivable entry per finalized version at `amountCents`, reverse it when the
version is superseded (the `supersededByVersionId` and `supersededAt` columns say which and when), and
apply payments against the invoice's current OPEN entry. No invoice, version or receivable row needs to
change shape: the ledger adds states (for example paid) and a link column, and a new migration, so the
trigger that allows only OPEN to SUPERSEDED would be widened then.

## Delivery, AR, payments and statements (#168, slice 4)

Caleb's decisions, Oct 4, 2026: an invoice goes out as **an email with a PDF of the finalized version attached**, only when
**conference staff send it** (never automatically, no reminders, no collection messages); the default recipients are the church's
active billing contact plus a copy to the club director(s) of the clubs on the invoice, and staff see the exact list and can
untick anyone; the church pays by check against its AR in the conference's own books, so staff mark an invoice "Posted to AR" and record
payments by hand; the treasurer gets a formula-safe CSV. Refunds, an accounting-system integration and cross-event statements are out of scope.

Everything below needs **MANAGE_FINANCE on the event in the URL** (checked again on the server for every action). It lives on the
invoice page (`/finance/invoices/[invoiceId]`), the send page (`/finance/invoices/[invoiceId]/send?version=`), the statements
(`/finance/invoices/statements`) and the report section at the foot of the Invoices list.

### The PDF

Made by `modules/invoices/invoice-pdf.ts` with **pdf-lib** (pure JavaScript, MIT, no native code and no headless browser; its only
dependencies are small pure-JS helpers), from the **finalized version's immutable snapshot** and a few fixed facts, never from live data:
the conference name (platform settings, plain text), invoice number (with `-R<n>`), issue date (the finalization time, in the event's time
zone), event, billed-to church and the billing contact **as finalized**, one block per club registration with registered and billable counts and its
amount, the credits, promo code, charges not tied to a person and staff adjustments under it, the total, "Supersedes SC27-0001" on a revision, and the
payment instruction. Attendee names are not printed, and neither is a registration's confirmation code (with a contact email it opens that registration, and the PDF goes to every director on the invoice): each block carries a plain "Line N" reference instead. The layout version is recorded on each document (now 3); a promo discount prints as "Promo discount" with no code, since a code may be private.

The payment instruction is a finance setting, not a fixed fact: the event's `invoicePaymentInstructions` (editable by MANAGE_FINANCE, audited), defaulting to
"Please remit by check to the Iowa-Missouri Conference." The text used is copied onto the stored document, so changing the setting later never changes a PDF
that was already made.

**Deterministic and stored once.** The renderer uses no clock and no random ids (creation and modification dates are the finalization time), so the same input gives
the same bytes (tests render twice and compare hashes). The PDF is made and stored **right after finalization commits**, by the finalize route, on a best-effort basis: if generation fails, finalization has already succeeded, the failure is logged, and the PDF is made on first view, download or send exactly as before (so a version may have no stored document yet; nothing is ever sent by this). Otherwise the first send or download stores the bytes (`MessageAttachment`, with `sizeBytes` and `sha256`, which a
database check ties to the content, and a trigger forbids rewriting) and one `InvoiceVersionDocument` per version (unique, only for a FINALIZED or SUPERSEDED
version, recording the hash, the layout version, the header name and the instruction used). **Every send and download reads those stored bytes**, verifies they still hash
to the recorded value, and never regenerates, so a resend cannot differ. The repository has no file store for generated files, so the bytes live in PostgreSQL
(one small row per version, referenced by every message that carries it).

### Who it goes to

`getInvoiceSendPreview` and `sendInvoiceVersion` (`modules/invoices/delivery-repository.ts`):

- **To:** the church's **current** active billing contact (#165), never the form submitter. A group billed to a person goes to that person.
- **Copy:** the **active director** (role Director, an unrevoked grant inside its date window, account not disabled) of each club on the invoice. A deputy, registrar,
  reporter or revoked director is not copied. An address appears once (a director who is also the billing contact is one recipient).
- Each recipient is **one outbox message**, so each gets their own copy and their own delivery, bounce and suppression status. The screen says "To" and "Copy", but no message
  shows the others on a header line.
- **Changed contact.** The PDF always shows the contact the invoice was finalized with. The email goes to the contact **now**. When they differ the preview says so
  ("The billing contact changed since this invoice was finalized"), names both, and the delivery record keeps `contactChangedSinceFinalization`. A page opened before the contact
  changed cannot send (the recipient fingerprint no longer matches: reload). A contact-only revision brings the PDF up to date.
- Staff untick anyone. **At least one recipient is required**. The page sends back only the **keys** that stay ticked (`billing`, `director:<account>`); the server recomputes
  who they are, so an address can never be supplied by the caller, and an unknown key is refused.
- The preview warns when the last invoice email to an address bounced, was suppressed, drew a complaint or failed; staff decide, nothing is blocked.

### Sending, resending and the record

A send is a staff action with a confirmation naming the sender and the recipient count, an editable subject and message (a default naming the invoice,
amount and payment instruction), and an idempotency key. In one transaction under the event's lock it re-checks that the version is **FINALIZED** (a version a revision
replaced cannot be sent: refused with the newer version named, and refused by a database trigger as well), recomputes the recipients, creates the append-only
`InvoiceDelivery` (version, sequence 1, 2, 3, the sender and the name they sent under, subject, document, whether the contact had changed) with one `InvoiceDeliveryRecipient` per
message, queues the messages in the **existing outbox** (template key `INVOICE_DELIVERY`, recipient kind `BILLING_CONTACT`, the stored attachment referenced by `attachmentId`,
the event's sender settings, HTML and text bodies), and audits it. After the commit it processes the new rows through the normal pipeline.

- **Delivery mode is respected.** `DISABLED` records each message as `SUPPRESSED` (nothing is emailed); `LOCAL_CAPTURE` captures it; `EXTERNAL_EMAIL` requires a verified
  sender and sends through Resend with the PDF attached (the delivery worker reads the attachment, verifies its hash and passes it to the provider; a mismatch is a definitive
  failure, never a send). A failed delivery leaves the rows queued for the normal retry and sweep; the delivery record stays.
- **Status is read from the outbox**, not copied: queued, captured, sent, delivered, **bounced**, marked as spam, failed or suppressed, kept up to date by the existing provider webhook.
  The invoice page lists every send with its recipients and statuses. A resend is a **new delivery record for the same version** with the same document and hash.
- A retry with the same key replays the first result and sends nothing more; the key cannot be reused for another version.
- The Communications "Retry" refuses an invoice message ("Resend this invoice from Finance → Invoices."): a retry would carry no delivery record and could resend a replaced version. Invoice messages are not event templates, so they do not appear in the Communications delivery log, which is where the Retry button lives.
- **A replaced version never goes out.** Finalizing a revision cancels the replaced version's still-queued invoice messages in the same transaction, and the delivery worker re-checks that the version is still FINALIZED before sending and cancels the message otherwise (shown as "Cancelled" in the history). The check runs when the message is claimed and again immediately before the provider call, and the local-capture path applies the same check; each worker cancellation is audited (ids and the reason "Invoice version superseded").
- Director copies are recorded with outbox recipient kind `CLUB_DIRECTOR` (the billing contact is `BILLING_CONTACT`). An attachment over 10 MB is refused at send with a clear message.
- Audit rows (`INVOICE_SENT`, `INVOICE_RESENT`) hold ids, counts, the document hash and the delivery mode: **never an email address or a name**.

### Posted to AR

"Mark posted to AR" (a date and an optional reference) records an `InvoiceArPosting` for a FINALIZED version, **once per version** (a unique index). A mistake is corrected only
by a **new posting that names the one it corrects and gives a reason**; nothing is edited or deleted (triggers). A revision is posted again, since the amount changed. Audited.

### Payments

"Record payment" (amount greater than zero, received date, optional check number and note) records an append-only `InvoicePayment` against the **OPEN receivable of the version
that is finalized at that moment**. Partial payments are allowed. A mistake is **voided with a reversal entry** (a new row naming the payment, repeating its amount, with a reason); a
payment is voided once, and nothing is edited or deleted. A client request key makes a double click record one entry.

**Outstanding = the live version's total (its OPEN receivable) less every payment, net of voids, on the invoice**, never below zero. **Revisions carry what was paid forward** without
moving any row: a $100 invoice paid $60 and revised to $90 leaves $30 outstanding; revised to $50 it shows $10 **overpaid**, flagged to staff (an overpayment is accepted and never hidden;
refunds are out of scope). A payment keeps pointing at the version it was recorded against, and the statement shows which. Recording and voiding lock the invoice row, so they
serialize with a revision being finalized, and the database refuses a payment against a superseded receivable.

### Statements and reporting

- **Statement** (`/finance/invoices/statements`, then one church): for the **event in the URL**, each church (or billing person) with a finalized invoice, then per invoice the live
  version, superseded versions as history, AR status (date and reference), sends, every payment with voids struck through, and what is outstanding. Attendee payments are not mixed in.
- **Cross-event visibility.** A statement is per event. The viewer must hold MANAGE_FINANCE on **that** event; the church comes from the URL but is only looked up among that event's invoices, so a
  church with no invoice on the event is a 404 and one event's finance staff never see another event's invoices (even for the same church). A conference-wide or cross-event statement is out of scope
  (it would need a rule for which events a person manages); each event's treasurer uses that event's statement.
- **Finance report** (foot of the Invoices list): submitted headcount, billable units, invoiced amount, posted-to-AR count and amount, sent and not sent, paid, outstanding and overpaid, with
  **deferred receivables kept apart from attendee payments** (shown separately, net of refunds).
- **Treasurer CSV** (`/api/events/<event>/exports/invoices`, MANAGE_FINANCE): the live finalized version of each invoice: number, what it supersedes, church, event, total, posted-to-AR date and
  reference, paid, outstanding, overpaid and the date last sent, through the shared CSV writer, so a cell that starts with `=`, `+`, `-` or `@` is neutralized. No accounting-system format.

### Security

The PDF and every attachment are served only through the staff route above (MANAGE_FINANCE on the event, `private, no-store`); there is no public or token URL for them, and a test scans `app/` to
prove no other route reads the stored bytes. A version of another event is a 404. Statements and the CSV follow the same event check. Audit holds ids only.

## Immutability, checked in the database

Database triggers (not only application code) enforce, and `npm run test:invoices` proves:

- a finalized or superseded version never changes (amount, snapshot, contact, number, reopening, delete),
  except its own FINALIZED to SUPERSEDED step; a draft changes only by counted regeneration; a version is
  created only as a draft;
- an invoice's number is assigned once; the counter only counts up by one; a receivable matches one
  finalized version and its amount and moves only OPEN to SUPERSEDED;
- the event's invoice code cannot change after numbers exist;
- foreign-key actions still work: deleting a user clears the creator or approver id (the approver's name
  stays on the invoice), and the rows go only when their event does. An event with registrations cannot
  be deleted at all (#620), so an event with invoices is never removed in practice.

## Not built, and open items

- **A printable web view** and any accounting-system export or API (the treasurer CSV below is the only export). Sending
  is built (#168) and is only ever a staff action: nothing is sent or scheduled automatically.
- **Void.** A $0 invoice is finalized, not voided. (An open draft can be discarded: see Drafts.) A finalized invoice is corrected by a revision, including one that brings it to $0.
- **A finalized invoice needs a billing contact**, so it has someone to be sent to. A group with none
  cannot be finalized until staff add one (Billing responsibility) and regenerate the draft. This is a
  stricter rule than the issue states; relax it if the conference wants contact-less invoices.
- **An invoice for registrations that left the reconciliation.** If a group disappears from the approved
  reconciliation, only a revision can bring its finalized invoice to $0; an unfinalized draft for it cannot
  be finalized.
- **Per-event permission** (see above): the treasurer is granted per event.
- The code of two events in the same year must differ; the screen explains the refusal.

## Checks

`npm run test:invoices` runs against a local or CI Postgres and proves: drafts only from a current
approved reconciliation (no approval, FACTS_CHANGED and responsibility blockers refused), grouped
registrations (a church with two clubs, and per-club grouping), idempotent and race-safe drafting, the
confirmation, the permission and stale-draft refusals, one number under parallel and retried
finalization (no duplicates, no gaps, per event, code and year), a key that cannot be reused, one receivable
per finalized version including $0, every kind of rewrite of a finalized version refused, a contact change
after finalization revised by finance staff (`-R1`, prior superseded and readable), an adjustment after
finalization re-approved and revised (needs the permission), cross-event refusals, the code lock and clash
checks, the permission grant and its removal, and audit rows with no contact name or email. Unit tests:
`tests/invoices-*.test.ts` (rules, service refusals, routes and permissions, screens, migration).

`npm run test:invoice-delivery` (#168) runs against a local or CI Postgres and proves: the PDF is made once from the snapshot and stored with a database-checked hash (rebuilding it from the
same snapshot gives the same bytes, parallel first requests make one document); a send queues one outbox message per ticked recipient with the stored attachment (billing contact now, club
directors only, no deputy or revoked grant, never the submitter), refuses none ticked, an unknown recipient, a changed list, a missing confirmation and another event, replays a retried key and sends
once under parallel requests; a resend is a new delivery record with the same document and hash; a bounce is recorded and warned about; event email off records suppressed messages; real delivery hands
the provider the stored PDF byte for byte; a contact changed after finalization is flagged and mailed at its new address while the PDF stays as finalized; a superseded version cannot be sent (and the
database refuses it); AR is once per version and corrected only by a new posting; payments are append-only with partial, voided and overpaid figures, a revision carries what was paid, and a payment
cannot hit a superseded receivable; statements, the report and the CSV are scoped to the event and the CSV is formula-safe; no audit row holds an address or a name. Unit tests:
`tests/invoice-delivery-domain.test.ts`, `tests/invoice-pdf.test.ts`, `tests/invoice-delivery-routes.test.ts` (permissions, unauthorized statement access, the PDF is never public) and
`tests/invoice-delivery-migration.test.ts`.
