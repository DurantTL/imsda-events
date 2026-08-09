# ADR 0012: Incident, safeguarding, and missing-person case management policy

Status: **Proposed — draft for review.** Not yet Accepted. Deliverable for
#257. Until Accepted, #258–#261 stay unclaimable, per roadmap #98's explicit
statement that they "remain unclaimable until #257 is approved." Attachments
and production case management stay disabled regardless of build status, per
#257's own acceptance criteria.

Date: 2026-08-09

## Context

#257 explicitly depends on the protected-record policy (#189–#192/ADR 0005)
and the minor-release/emergency foundations (#114, #215–#217/ADR 0006). This
ADR is written to sit on top of both rather than duplicate them:

- The **compartmentalization and dedicated-permission pattern** ADR 0005
  established for protected medical records (a role that can see the roster
  doesn't automatically see the content) is the right shape for incident
  compartments too — a session-attendance issue and a safeguarding concern
  about the same event should not share a permission boundary.
- The **break-glass, reason-required, mandatory after-use review** pattern
  from ADR 0005 §3 and ADR 0006 §4 (minor-release overrides) is proposed as
  the same mechanism incident escalation reuses, not a fourth implementation
  of elevated access.
- ADR 0006's explicit rule that "transport arrival never implies guardian
  release" has a direct analog here: an incident record referencing a
  transport, lodging, or personnel fact must reference it, not restate or
  duplicate it — the same minimum-necessary-cross-reference principle #257
  itself asks for.

This is the broadest and most consequential of the gates drafted so far — it
touches legal mandatory-reporting obligations, litigation/insurance
preservation, and safeguarding. This ADR proposes structure and states plainly,
in more places than the other drafts, where it is *not* proposing an answer
because the answer is a legal or safeguarding judgment call, not a technical
default.

## Decision

### 1. Mandatory reporting and the "software never claims fulfillment" rule

**Not proposed here, and not defaultable:** which incident categories trigger
a mandatory-reporting obligation, to which agency, on what deadline, and who
decides a report is required. #257 already states the one rule that isn't
optional: *"software never claims a legal duty has been fulfilled
automatically."* This ADR treats that as settled and non-negotiable —
whatever else this policy decides, the system may record that a human marked a
report as made, and to whom, but must never infer or assert that a legal
obligation has been satisfied on its own. Everything else in this section
needs a named legal/safeguarding owner, not a proposal from this document.

### 2. Compartments and minimum-necessary cross-reference

**Recommended:** separate compartments for incident, safeguarding, medical
(shared boundary with ADR 0005), personnel (shared boundary with ADR 0011),
custody (shared boundary with ADR 0006), transport, lodging, facility,
security, and missing-person — each with its own dedicated permission. A case
that touches multiple compartments (a missing-person search that becomes a
medical incident) references the related record by ID, not by copying its
content into the incident record. This keeps a security-compartment reader
from incidentally gaining medical-compartment visibility just because the two
cases are related.

**Decision needed:** the exact compartment list and which roles hold which
compartment's permission — proposed above as a starting structure, not a final
list.

### 3. Append-only semantics, correction, and closure

**Recommended, matching every other append-only pattern already in this
codebase:** an incident timeline entry is never deleted or edited in place;
correction adds a new entry referencing what it corrects. Closure and reopen
are explicit state transitions, not implied by inactivity. **Decision
needed:** whether *any* entry may ever be removed (e.g., an entry created in
error, versus an entry someone later wishes hadn't been written) — #257 asks
this directly, and this ADR's recommendation is that the answer should be no
entries are ever removed, only superseded, consistent with the platform's
append-only convention everywhere else, but this is a legal-preservation
question the named legal/insurance owner should confirm rather than accept by
default.

### 4. Retention, legal hold, and litigation/insurance preservation

**Not proposed here.** Retention for an incident record plausibly needs to
outlast ordinary event data retention by a wide margin, and a legal hold must
be able to override any configured deletion schedule outright. This is exactly
the kind of decision ADR 0005 and ADR 0006 both declined to default, and the
stakes here are at least as high. Needs a named legal/insurance owner.

### 5. Evidence, attachments, and chain of custody

**Recommended structure, not enabled by default:** attachment types, chain-of-
custody metadata (who added it, when, from what source), and storage/key
custody follow the same encrypted-storage approach ADR 0005 proposes for
protected records — reuse the key-custody and rotation answer from ADR 0005
rather than deciding a second one. **Per #257's own acceptance criteria,
attachments remain disabled until this ADR is Accepted and the storage
approach is confirmed** — this ADR does not turn them on.

### 6. Escalation, notification, and outage procedure

**Recommended:** an escalation/notification matrix keyed by category and
severity, with recipients and order defined per category, minimized content
(status and identifiers sufficient to act, not full case detail — same
minimum-necessary principle as ADR 0006 §6), required acknowledgment, and a
defined fallback when a primary recipient doesn't acknowledge in time.
**Decision needed:** the actual matrix (who is notified for which category/
severity) and the outage/manual procedure when the notification system itself
is unavailable during an active incident — this is an operational continuity
decision for incident-command ownership, not a default this ADR can set.

### 7. Verification before any real use

**Recommended:** synthetic scenario testing across the cases #257 already
names — missing person, medical escalation, custody conflict, severe weather,
transport incident, safeguarding concern, simultaneous incidents, and an
outage during an active incident — before any production case management is
enabled, matching #257's acceptance criteria directly.

## Consequences

- Reusing ADR 0005's and ADR 0006's break-glass, compartmentalization, and
  key-custody answers means incident case management doesn't introduce a
  fourth elevated-access or encryption design to audit.
- The largest open items (mandatory-reporting matrix, retention/legal hold,
  escalation matrix) all require a named legal/safeguarding/insurance owner
  this ADR cannot substitute for. That's deliberate: #257 is explicit that
  "software never claims a legal duty has been fulfilled automatically," and
  an agent defaulting these would risk the same category of error in reverse
  — implying a policy exists when it hasn't actually been decided by anyone
  accountable for it.

## Alternatives considered

**Store all incident detail in one compartment for simplicity.** Rejected —
collapses exactly the boundaries #257 asks for (safeguarding, medical,
personnel, custody are each independently sensitive) and would mean any
incident-access grant is effectively a grant to every sensitive domain at once.

**Allow entries to be deleted, not just superseded.** Rejected as the
recommended default — but explicitly left for the named legal owner to
overrule, since litigation-preservation requirements can cut either way
depending on jurisdiction and the platform shouldn't guess.

**Build a separate break-glass/audit mechanism specific to incidents.**
Rejected — the same reasoning as ADR 0011: one audited elevated-access pattern
reused across protected-records, minor-release, personnel, and incident
domains is easier to verify than four independent ones.

## Approvals needed

- [ ] Safeguarding/risk owner
- [ ] Legal/insurance owner (mandatory reporting, retention, legal hold — the
      two items this ADR most explicitly declines to default)
- [ ] Privacy/security owner (compartments, attachment storage/key custody)
- [ ] Incident-command owner (escalation/notification matrix, outage procedure)
- [ ] System-operations and support owners

## Related

- Parent: #79 (incident/safety/missing-person epic)
- Depends on: #189–#192/ADR 0005, #114, #215–#217/ADR 0006
- Blocks: #258, #259, #260, #261
- Roadmap: #98 (Phase 3F)
