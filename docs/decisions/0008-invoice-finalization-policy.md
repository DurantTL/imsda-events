# ADR 0008: Deferred-organization invoice approval and finalization policy

Status: **Proposed — draft for review.** Not yet Accepted. Deliverable for #167.

Date: 2026-08-09

## Context

#167 depends on organization billing responsibility (#165), reviewed
attendance reconciliation (#166), and the ledger foundations (#117–#120).
Like ADR 0007, this ADR doesn't resolve that build ordering — it resolves the
approval-authority question that blocks #167 regardless of when the
dependencies land: **who may finalize an invoice, and what makes a finalized
invoice trustworthy enough that it's never silently rewritten.**

The immutable-snapshot-plus-linked-revision pattern already exists elsewhere
in this codebase (consent versions, the ledger's append-only entries) and
should be reused here rather than re-derived, per #167's own scope: "Drafts
are editable only through explicit regeneration or adjustment; finalized
invoice versions are immutable... Corrections after finalization create an
adjustment or revised invoice version linked to the prior one; they never
overwrite it."

## Decision

### 1. Who holds finance permission to finalize

**Decision needed, not defaulted:** #167 requires "finance permission, named
human approval" for finalization, but doesn't say what distinguishes finance
permission from ordinary event-admin access. **Recommended:** a dedicated
permission, separate from general event administration — the same reasoning
ADR 0005 applies to protected-data access applies here: being able to
administer an event's registrations shouldn't automatically mean being able to
commit the organization to a legally meaningful invoice number.

### 2. What "approved reconciliation" means as an invoice input

#167 says a draft must trace to "one approved reconciliation or an approved
grouping of registrations." **Decision needed:** is "approved" here the same
attendance reconciliation from #166 (a separate, already-approved step), or
can invoice finalization itself serve as the first approval of a
not-yet-reviewed grouping? **Recommended:** require #166's reconciliation
approval as a precondition, not something invoice finalization can substitute
for — collapsing the two makes it harder to tell, after the fact, whether a
disputed invoice was ever independently checked against attendance.

### 3. Idempotent numbering and concurrency

**Recommended:** invoice number assignment happens exactly once per
finalization, using the same idempotency-key discipline the platform already
applies to payments (per `docs/PRODUCTION-READINESS-PROGRESS.md`'s mention of
"idempotency on payments and registrations"). A retried or concurrent
finalization request must be safely rejected or return the same already-issued
number — never mint a second one for the same draft.

### 4. Revisions and adjustments

**Recommended, matching #167's own scope:** a correction after finalization is
a new invoice version linked to the one it supersedes; the prior version stays
readable in full. Ledger entries and receivables reference a specific invoice
version, not "the invoice" as a mutable concept, so a report generated before
a revision stays internally consistent with the version it was built from.

**Decision needed:** does a revision require the same named-approval step as
the original finalization, or can a minor correction (e.g., a contact-detail
fix that doesn't change the total) skip it? **Recommended:** anything that
changes a billable amount requires the same approval; anything that doesn't
(contact info, notes) does not.

### 5. What this ADR does not decide

Delivery (email/PDF), external accounting-system export, and cross-organization
grouping are explicitly out of #167's scope and out of this ADR's — they're
separate future work (#168 and beyond), not a precondition for finalization
policy.

## Consequences

- A dedicated finance permission narrows who can commit the organization to an
  invoice, independent of who can otherwise administer the event.
- Requiring #166's reconciliation approval as a hard precondition (rather than
  letting finalization double as first review) means a disputed invoice always
  has an independently approved attendance basis to point to.
- Version-linked revisions mean a report or statement generated at any point in
  time remains explainable against the invoice version that existed then.

## Alternatives considered

**Allow any event-admin to finalize.** Rejected — the same reasoning ADR 0005
applies to protected-data access: administrative convenience is not authority
to commit an organization to a bill.

**Overwrite the draft in place on correction instead of versioning.** Rejected
— explicitly ruled out by #167's own acceptance criteria, and inconsistent
with every other immutable-snapshot pattern already in the codebase (ledger,
consent).

## Approvals needed

- [ ] Finance owner (names the finance-permission role, confirms the
      reconciliation-precondition rule)
- [ ] Ministry operations owner

## Related

- Parent: #67 (deferred church invoicing epic)
- Depends on: #165, #166, #117–#120
- Roadmap: #98 (Phase 1E)
