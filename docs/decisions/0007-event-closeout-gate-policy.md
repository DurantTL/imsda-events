# ADR 0007: Operational and financial closeout gate policy

Status: **Proposed — draft for review.** Not yet Accepted. Deliverable for #158.
Until Accepted, #158 stays without `codex-ready`, and the event-lifecycle
archival slice (#159) that follows it should not be treated as a real
production capability, only a technically buildable one.

Date: 2026-08-09

## Context

#158 depends on ledger reconciliation (#123), which depends on the full ledger
chain (#117–#122) — none of it built yet. That sequencing is a separate,
ordinary dependency and this ADR doesn't try to resolve it. What this ADR
resolves is the part that's a policy question regardless of build order: **who
is allowed to say an event's books are closed, and what does the checklist
actually have to contain** before that authority can say so.

Two existing patterns should carry forward into this design rather than being
reinvented:

- The **shadow-check-before-flip** discipline already established for the
  ledger cutover (#121): don't let a check pass by assumption — assert it
  against real derived data, and don't allow a stale read to close against
  facts that changed underneath it.
- `modules/audit`'s existing audit log, which the checklist's every satisfied
  check, warning, blocker, and human attestation should write to, using the
  same `entityType`/`entityId`/`actorUserId` shape already used elsewhere.

## Decision

### 1. What "closed" requires, and who may say so

**Recommended:** a versioned, event-level checklist definition (not
hardcoded per event) with each item classified as one of:
`SATISFIED` (machine-derived, no human input), `HUMAN_ATTESTATION_REQUIRED`
(machine surfaces the fact, a named human confirms), `WARNING` (non-blocking,
visible), or `BLOCKER` (closure cannot proceed). #158's scope already lists the
minimum set: registration/attendance totals, unresolved balances/refunds/
disputes, failed payments, deferred invoices, settlement exceptions, message
failures, waitlist offers, merchandise exceptions, final exports, backup
evidence, retention actions. This ADR proposes accepting that list as the
minimum and asks for confirmation of two things it doesn't itself decide:

- **Decision needed:** which items are hard `BLOCKER`s (closure cannot happen
  at all) versus `HUMAN_ATTESTATION_REQUIRED` (a named person can accept the
  exception and proceed, with the reason recorded)? The issue's scope doesn't
  distinguish these, and the difference materially changes what an event lead
  can do without escalating.
- **Decision needed:** who holds "financial closeout" authority — a specific
  role (e.g., a finance/event-admin permission distinct from ordinary
  event-admin), or a named individual per event? #158 says "explicit permission
  and named approval" but doesn't say whose.

### 2. Staleness and concurrency

**Recommended:** the checklist run is versioned and bound to the ledger/data
state it was computed against (same idea as the ledger's shadow check —
compute, don't assume). If the underlying data changes after the checklist
was generated and before approval is submitted, the approval attempt fails and
must be regenerated, rather than closing against facts that no longer hold.
Concurrent closeout attempts on the same event are rejected past the first, not
merged.

### 3. Auditability and reopening

**Recommended:** every checklist run, its item-level results, the approving
actor, and evidence references are retained even after a later reopen —
reopening creates a new checklist version rather than erasing the prior one's
history, matching the append-only pattern already used for consent (#129–132)
and the ledger. This is already in #158's acceptance criteria; this ADR just
confirms it's the intended pattern rather than a per-event convention someone
might skip.

### 4. What "final exports" and "retention actions" mean here

**Not proposed here.** #158 lists "final exports" and "applicable retention
actions" as checklist categories, but what gets exported and what retention
period applies depends on the retention decisions made in ADR 0005 (protected
records) and whatever this event's data-retention configuration says. This
checklist item should reference those policies rather than define its own.

## Consequences

- The checklist definition becomes buildable independent of whether the full
  ledger chain (#117–#122) is finished, since the policy question (blocker vs.
  attestation, who approves) is separable from "does the data exist yet."
  Actual closure obviously still needs the ledger to be real.
- Naming the approval authority now avoids a worse conversation later: an
  event-admin who assumes they can close finances and can't, mid-event.

## Alternatives considered

**Let any event-admin close any checklist item.** Rejected — #158 is explicit
that "automation cannot approve" financial reconciliation, and treating
financial closeout as no different from an operational checklist item would
erase that distinction.

**Skip staleness checking and let closure proceed against whatever data is
current at approval time.** Rejected — this is exactly the class of bug the
ledger's own shadow-check discipline exists to prevent; a closeout gate is a
worse place to introduce it, not a better one.

## Approvals needed

- [ ] Finance/operations owner (defines blocker vs. attestation split, names
      the closeout-approval role)
- [ ] Ministry operations owner

## Related

- Parent: #72 (event lifecycle epic)
- Depends on: #123 (ledger reconciliation), and transitively #117–#122
- Related: #67, #77, #140
- Roadmap: #98 (Phase 1E)
