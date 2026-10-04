# Attendance reconciliation (#166, slice 2)

For events billed to organizations after the event (`DEFERRED_ORGANIZATION_INVOICE`, such as
Spring Camporee). It turns who was registered and who actually came into a reviewed, approved set
of billable units per invoice group. It does **not** finalize, number or send an invoice (#167,
#168, ADR 0008): nothing is sent, and the church and club director see nothing from this screen.

The screen is Finance, then Attendance reconciliation (`/finance/attendance-reconciliation`),
linked from the Finance page and from Billing responsibility. Only MANAGE_FINANCE on the event can
open it, use its actions, or download its CSV; every action checks the permission again on the
server and refuses any person or version outside the event in the URL. The location filter (#413)
narrows what is shown and exported; preparing and approving always cover the whole event.

## The policy (Caleb, Oct 4, 2026)

A church is billed only for the people who were checked in. Registered people who never came
(sickness, other reasons) are no-shows and are not billed. Amounts shown before the event (Owed by
churches, Billing responsibility) stay estimates based on registration; invoices will use the
reconciled attended count.

## Source facts, kept apart

| Fact | Where it comes from |
| --- | --- |
| Registered | The people on a submitted or confirmed registration when you look (a late addition is flagged "added after submission", a substituted person "substituted") |
| Checked in | A check-in record that has not been undone (`CheckIn`, the same record club check-in writes) |
| Staff correction | `AttendanceCorrection`: "mark attended" (came, missed at check-in), "mark not attended" (checked in by mistake), or "withdraw" (back to the check-in record). Reason required, actor recorded, audited |
| Price | The registration's recorded price lines (the latest amendment's, else the submission's) |
| Credit | The #409 meal-sponsorship credit, recomputed from the form's own credit field |
| Promo code | The whole-registration code (`PromoCodeRedemption`) and the discount in the latest pricing snapshot |
| Responsible party | The RECORDED billing responsibility (#165), grouped per church or per club as the event's setting says |

Not in the codebase, so not invented here: excluded people and complimentary roles. A free person
is simply a $0 price line. If the conference later needs a "staff and volunteers are not billed"
rule, it is a new input to this reconciliation (and a rule-version bump), not a hidden exception.

## Counts, side by side

Per registration, per invoice group and for the event:

- **Registered**: people on the roster.
- **Checked in**: check-in evidence.
- **No-show**: registered minus checked in, before any correction.
- **Adjusted by staff**: +added (marked attended, not checked in) and −removed (checked in, marked
  not attended). Shown separately so a church can see why its count differs.
- **Billable**: checked in + added − removed. The database enforces both equations on every saved
  version.

## Amounts: #409 applied to people who attended

- A person's own price lines (the per-person rate, which already carries the late price when the
  registration was priced after the late date) count only for attended people.
- **Registration-level charges** (a flat or late fee for the whole registration, or a per-unit
  charge, not for a person) cannot be split per person. They follow #409: kept whole, once. Choice
  made here: they apply while at least one person attended and are $0 when nobody did, because a
  church is not billed for a registration nobody came to. They are listed per registration under
  "Charges not tied to a person" and in a CSV column so staff can see them. Whether they should
  shrink with attendance is a decision for Caleb; this keeps the estimate's behaviour until then.
- **Whole-registration promo code** (the redemption recorded when the registration was priced or
  amended; per-person codes are adjustment rows and are counted with the adjustments, never twice):
  it applies to what the attended people owe after credits, the way the estimate applied it to the
  registered subtotal. A percentage code gives the same percentage (and honours its maximum); a
  fixed code is applied in full, capped at what the attended people owe. Neither ever exceeds the
  discount the estimate recorded, so a registration where everyone attends never bills more than
  its estimate, and nothing goes below $0. It is shown as its own line on the screen, in the
  snapshot and in the CSV. A code's minimum-subtotal condition is not re-checked against the
  smaller attended subtotal (the church keeps the discount it was promised); this is a deliberate
  choice, to be revisited if the conference wants the condition enforced.
- **Meal-sponsorship credit**: units entered times the form's credit per unit, capped at the people
  who **attended** (the estimate caps it at the people registered), and never more than the
  charges. If the form's credit field cannot be found (an old form), the recorded credit is kept
  as it was.
- Staff adjustments (#396/#397): registration-wide ones count while anyone attended; one made for a
  person counts only if that person attended.
- A registration with no price lines on file (entered by staff) has no per-person figures, so its
  estimate is prorated by attended over registered and labelled "Prorated from the estimate".
- Waitlisted and cancelled registrations owe nothing and are out of scope.
- The amount for a registration never goes below $0.

## Versions

1. **Prepare reconciliation** saves a DRAFT: an immutable snapshot of every input and result (per
   person, registration and group), the rule version (`attended-v1`), the grouping, and the totals.
   Preparing again with nothing changed returns the same version and writes nothing (a fingerprint
   of the facts; only one non-superseded version may carry it). A changed fact or rule makes a new
   draft and supersedes older drafts. Two staff preparing at once end with one version.
2. **Approve** (MANAGE_FINANCE) turns a draft into APPROVED, recording who and when. It is refused
   if the draft's facts no longer match (prepare again), if the draft was superseded, or while
   billing responsibility is not ready. Exactly one version per event is approved; approving a
   newer draft supersedes the earlier approval in the same transaction. Two approvals at once
   approve once.
3. An APPROVED or SUPERSEDED version never changes: database triggers refuse any rewrite of the
   snapshot, counts, amounts or fingerprint, any reopening, and any delete. Later check-ins,
   corrections or roster changes do not alter it. The screen shows "Facts changed since approval"
   and staff can prepare a new draft to review the difference.

The view's "People" drilldown shows each person's status (checked in, no-show, corrected) and the
correction reason and actor. Correction buttons appear only on the live view, never on a saved
version.

**What a saved version holds.** For a correction, only its id, kind and the person: never the
reason text, who made it, or when. The screen reads those live from the append-only correction row
(it never changes), so no free text is copied into a snapshot. The fingerprint ignores the
correction's id, so withdrawing a correction and re-entering an identical one (same person, same
kind) does not force a new approval. The reason field tells staff not to include health or medical
details ("did not attend" or "missed at check-in" is enough), and audit rows never hold the reason.

**One thing at a time.** Prepare, approve, correct and acknowledge all take one per-event database
lock (`pg_advisory_xact_lock`) and read everything, including the billing responsibility view, through
the same transaction. Approve re-reads the facts inside its locked transaction and refuses if they
differ from the draft. Other writers (check-ins, roster and price changes) do not take the lock: if
the facts move after an approval the version is flagged FACTS_CHANGED, never altered. **#167 must
refuse to finalize from an approval whose freshness is FACTS_CHANGED** and ask staff to prepare and
approve again.

**The fingerprint** is built from an explicit projection of the result: everything except a
correction's id and an acknowledgement's id (a correction counts by its kind and person, an
acknowledgement by its existence and choice).

## Roster changed after pricing (member transfers)

Prices are matched to people by their place in the roster listing (position, then creation time).
That place is stable: amendments re-snapshot the prices, a substitution keeps the seat, and editing
a name does not move anyone. So names are never used to doubt a price (a staff name edit, or a
generic "Attendee 2" label, flags nothing). Only a **member transfer** moves people between
registrations, and the transfer re-parents the attendee row (same id), gives them the last place on
the receiving registration, and so loses the place they had on the sending one. The reconciliation
rebuilds it:

- **Sender**: the roster as it was priced is the current people plus those transferred out after the
  sending registration's pricing snapshot, ordered by creation time, and the snapshot's lines are
  mapped by that original index. The person who left is not billed to the sender.
- **Receiver**: a person transferred in after the receiving registration was priced has no line in
  its snapshot, so they are billed (if they attended) from their line in the sender's snapshot,
  attributed to the receiving registration and so to its church, and shown as "Transferred from
  <club>".
- **When it cannot be certain** the registration is marked "Needs review": the remaining people are
  not in strictly increasing creation order, two people were created at the same moment, a move no
  longer names the person who left, someone moved more than once, the sending registration is not
  billed or was re-priced after the move, or a price line points past the roster. The screen then
  shows both figures, "Per-person (best match)" and "Prorated", and approval waits until staff
  acknowledge with a reason and **choose which to bill**. Until then the prorated figure is used.
  Prorating scales the whole registration's estimate, including charges not tied to a person. The
  acknowledgement is append-only, audited, and names exactly what was reviewed (the transfers and the
  stray price-line indexes), so a new transfer or stray line needs a new one; the choice is part of
  the fingerprint, so acknowledging means preparing again, then approving. A flagged registration
  that bills nothing (nobody attended) does not block approval.

Known limit: the rebuild assumes the roster order was creation order for the people who stayed (it
checks this) and for the person who left (which it cannot check; the place they had was overwritten).

## Blocked until billing responsibility is ready (#165, #167)

Invoices go to the recorded responsible party, so preparing and approving are refused while any
billed registration is unrecorded, out of date, or unresolved. The screen lists each one with the
reason and a link to Billing responsibility. Corrections stay possible meanwhile.

## CSV

One row per registration with the invoice group, counts, estimated and billable amounts, the
promo code, charges not tied to a person, how the amount was worked out, the version, whether facts
changed since approval, and the roster review state. It contains the responsible party and the
club or registrant name, not attendee lists.
Cells go through the shared formula-safe writer. `?version=` exports a saved version.

## Known limits and open items

- "Added after submission" compares the attendee's creation time with the registration's
  submission time (60 second grace); it is informational and does not change an amount.
- A substitution replaces the person on the same roster seat, so a check-in recorded before a
  substitution stays with the seat. Staff correct it when it matters.
- If an attendee record is deleted, a staff adjustment that was for that person loses its link and
  is then counted as a whole-registration adjustment (the existing foreign-key behaviour).
- Invoice numbering, finalization and delivery (#167, #168), and any exclusion or complimentary
  concept, are out of scope.

## Checks

`npm run test:attendance-reconciliation` runs against a local or CI Postgres and proves:
attended-only billing with the credit, blocked-until-recorded, idempotent and race-safe prepares
and approvals, the immutable approved version (every kind of rewrite refused), attendance changed
after approval, append-only corrections with one active per person under parallel writes,
cross-event refusals, foreign-key actions, and no audit row holding a reason or a name.
