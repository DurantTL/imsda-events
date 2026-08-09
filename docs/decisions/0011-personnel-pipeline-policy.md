# ADR 0011: Personnel record boundaries, disclosure, and pipeline authority

Status: **Proposed — draft for review.** Not yet Accepted. Deliverable for
#252. Until Accepted, #253–#256 stay unclaimable, per roadmap #98's explicit
statement that they "remain unclaimable until #252 is approved."

Date: 2026-08-09

## Context

No personnel/staffing code exists yet — this is the earliest gate in that
domain, and unlike ADR 0009 (Sterling) there's no partially built technical
slice to anchor against. What does exist and should inform this ADR:

- The worker-requirement/readiness model from #115 and the Sterling gate
  (#218/ADR 0009) — a personnel record needs the same requirement/checklist
  projection, not a second one.
- `ExternalIdentity` already supports provider-scoped identifiers (Sterling,
  eAdventist, CMMS, UltraCamp) — the same "one authoritative source per domain,
  reference it rather than copy it" principle #252 asks for at the record-
  boundary level already exists at the identity level.
- ADR 0005's access-permission pattern (dedicated permission distinct from
  ordinary event-staff access, status-only disclosure to operational roles,
  break-glass with mandatory after-use review) is the right shape to reuse
  here rather than invent a second disclosure model for a different sensitive
  domain.

#252 is unusually broad — it's asking for a source-of-truth map across
applicant, worker, volunteer, contractor, employee, and former-worker states,
several of which may already live in another system (HR/NCS/other). This ADR
proposes structure and flags the largest open questions; it does not attempt
to settle every bullet in #252's "Human decisions required" list, several of
which (legal/employment obligations, minor-applicant rules) are explicitly
named in #252 itself as out of scope for automation to infer.

## Decision

### 1. Record boundaries and source of truth

**Decision needed, not defaulted:** for each of applicant, candidate, offered,
accepted worker, volunteer, contractor, employee, event attendee, supervisor,
and former-worker — which records live in IMSDA Events, and which remain
authoritative in an external HR/NCS/other system with IMSDA Events holding
only a reference? **Recommended default posture:** IMSDA Events is
authoritative for anything that governs *event participation* (deployment,
shift assignment, event-scoped access, event-scoped readiness projection);
anything that's an employment-law record (payroll, formal HR file, legal
employment status) stays external and is referenced, not copied — this
mirrors the "reference, don't duplicate" rule `modules/organizations` already
follows for provider identities.

### 2. Permission and disclosure matrix

**Recommended, reusing ADR 0005's shape:** applications, references, interview
notes, and offer details get a dedicated personnel-access permission, distinct
from event-staff access and distinct from the protected-medical-data
permission in ADR 0005 — a supervisor reviewing shift coverage should not
incidentally see reference-check notes. Training/screening readiness is
exposed as a status projection (ready/pending/action-required), reusing the
same provider-neutral states #218/ADR 0009 already establishes, not the
underlying evidence.

**Decision needed:** the specific role(s) that hold personnel-access
permission, and whether reference-check confidentiality (a referee's comments
staying hidden from the applicant) is an absolute rule or a configurable one.

### 3. Pending-work and override behavior

**Recommended, matching the fail-closed principle already established for
Sterling (#113, ADR 0009):** an applicant/worker whose training or screening is
`PENDING` or `ACTION_REQUIRED` is restricted from assignments that require that
specific readiness by default. An override that assigns someone anyway
requires the same elevated-permission-plus-reason-plus-review pattern proposed
in ADR 0006 §4 (minor release overrides) — sharing one override/review
mechanism across personnel, protected-records, and minor-release domains
rather than building three.

**Decision needed:** override expiration (does an override apply to one
assignment or persist until revoked?) and who reviews it after use.

### 4. Offer, acceptance, and access provisioning

**Decision needed:** who holds authority to extend/accept an offer in the
system (is this itself a named-approval action, similar to invoice
finalization in ADR 0008?), whether electronic acknowledgment/signature is
required, and how accepting an offer translates into actual system access —
recommended: access provisioning is a distinct, explicit step after
acceptance, never implied by offer status alone, consistent with roadmap
principle 13.

### 5. Minor-applicant rules

**Not proposed here** — #252 explicitly calls this out as a human decision, and
it overlaps with the guardian-authority questions ADR 0006 raises for minor
release. If IMSDA Events ever accepts a personnel application from a minor,
that policy should be decided alongside ADR 0006's guardian-authority answers,
not independently.

### 6. Retention, correction, and post-employment access

**Decision needed:** retention schedule per record class (application,
reference, offer, training evidence, deployment history), correction/dispute
process, and what a former worker retains access to after offboarding.
**Recommended default:** former-worker access to their own historical
application/training records persists in some read form after offboarding
(so someone can see their own history if they reapply), but operational
access (schedules, rosters, assignments) is revoked immediately — this mirrors
the "revocation is immediate, history is preserved" pattern already used for
declared authority in ADR 0006.

## Consequences

- Sharing the disclosure-matrix shape and override/review mechanism across
  ADR 0005, 0006, and this one means one audited elevated-access pattern to
  build and review, not three.
- Naming which records IMSDA Events owns versus references keeps #253–#256
  from duplicating an HR system's authoritative data, which is the single
  costliest mistake to unwind later (two systems disagreeing about someone's
  employment status).
- The unresolved items (source-of-truth map, specific roles, offer authority,
  minor-applicant rules, retention schedule) require named domain owners this
  ADR cannot substitute for — it structures the decision, not makes it.

## Alternatives considered

**Treat every personnel record as IMSDA-authoritative by default.** Rejected —
duplicating employment-law records (payroll, formal HR file) that already have
an authoritative system elsewhere creates exactly the two-sources-of-truth
problem roadmap principle 2 exists to prevent ("document which system owns
each data domain during transition").

**Build a separate override/review mechanism for personnel instead of reusing
ADR 0006's.** Rejected — the same elevated-access, reason-required,
after-use-reviewed shape applies; a second implementation would mean auditing
two mechanisms that do the same thing for adjacent sensitive domains.

## Approvals needed

- [ ] HR/ministry owner (record boundaries, source-of-truth map, offer authority)
- [ ] Safeguarding/risk owner (minor-applicant rules, alongside ADR 0006)
- [ ] Privacy/security owner (disclosure matrix, reference confidentiality)
- [ ] Operations owner (pending-work/override rules, retention schedule)

## Related

- Parent: #93 (staff recruiting/onboarding/deployment epic)
- Existing foundation: #115, #218/ADR 0009
- Blocks: #253, #254, #255, #256
- Related: ADR 0005 (disclosure/break-glass pattern), ADR 0006 (override/review
  pattern, minor-applicant overlap)
- Roadmap: #98 (Phase 3F)
