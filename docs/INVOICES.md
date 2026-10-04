# Invoices: drafts, finalization and revisions (#167, slice 3)

For events billed to organizations after the event (`DEFERRED_ORGANIZATION_INVOICE`, such as Spring
Camporee). It turns the approved attendance reconciliation (#166) and the recorded billing
responsibility (#165) into one invoice per church or club, reviewed by a person and then finalized by a
named person with permission. Decisions: ADR 0008 and Caleb's Oct 4, 2026 answers on the issue.

**Nothing is sent.** Finalizing assigns a number and freezes the invoice; it does not email, print or
notify anyone, and the church and club director see nothing from this screen. Sending is #168 and is a
separate staff action. There is no automatic finalization, no scheduled job and no reminder.

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

- **Sending, PDF and email** (#168), a printable view, and accounting export. Nothing is sent or scheduled.
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
