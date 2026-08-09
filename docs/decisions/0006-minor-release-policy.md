# ADR 0006: Minor pickup, custody, and release policy

Status: **Proposed — draft for review.** Not yet Accepted. This is the deliverable
GitHub issue #215 asks for; the ADR becomes Accepted only once the named
approvers below sign off. Until then, #216 and #217 stay off `codex-ready` — both
explicitly declare themselves blocked on this policy in their own issue bodies.

Date: 2026-08-09

## Context

No code for guardian authority, custody, or minor release exists yet. The
nearest existing model is `Household` / `HouseholdMember`, and it's important
that this ADR not lean on it: household membership is a convenience grouping,
not a custody claim, and #216's acceptance criteria already say so explicitly
— *"Household/account status alone creates no pickup authority."* Declared
guardian authority is its own future model (#131, Consent slice 3), separate
from household membership and from consent to attend.

Three future capabilities depend on the decisions here without duplicating
records: transportation arrival status (#204–#206), event check-in, and
emergency plans (#114). #217's scope is explicit that none of these may imply
each other — *"Transportation arrival never implies guardian release; both
events must be independently present where required."* This ADR should keep
that separation rather than collapse it for convenience.

This document proposes structure and flags open questions; it does not make
custody determinations, is not a legal opinion, and does not implement
anything. Per #215's acceptance criteria, no production release or custody
workflow enables before this ADR is Accepted.

## Decision

Each subsection is one of the "human decisions required" from #215.
**Recommended** marks a proposed default; unmarked items are open questions
that need a named answer because a wrong default here has real safety
consequences.

### 1. Who may authorize pickup, and how authority is verified or revoked

**Recommended structure** (matches #216's already-written scope, which this
ADR should ratify rather than re-derive): an authorized-pickup-person record
scoped to one child, one authorizing guardian/actor, a relationship, an
event/session/date range, an effective-dates window, and a state
(active/revoked/expired/superseded). Revocation and correction create new
history rather than erasing prior authority — the same append-only pattern the
platform already uses for consent (#129–#132) and the ledger (#117).

**Open question:** who counts as an "authorizing guardian/actor" in the first
place — is this gated on the declared-guardian-authority model from #131, or
can event staff also register a pickup authorization directly (e.g., for a
grandparent brought in by a phone call the day of the event)? The scope note in
#216 implies both paths may be needed; this ADR should say which are permitted
and under what verification.

### 2. Recipient verification, credentials, and self-release policy

**Recommended:** pickup credentials (codes/QR references) are scoped to one
event/date, short-lived, revocable, hashed where stored, and never reveal a
child's name or identity if presented or logged out of context — matching
#216's acceptance criteria ("Credentials cannot enumerate or publicly reveal a
child"). Physical ID verification at the point of release is a staff procedure,
not something software can confirm — the system should record *that* a
verification method was used and *what* the outcome was, not attempt to
validate an ID itself.

**Open questions, not defaulted here:**
- What in-person verification methods are acceptable (photo ID check, code
  plus visual family recognition, both) — this is a staff-procedure decision as
  much as a software one.
- Self-release: is any attendee age ever permitted to leave without a pickup
  event? **Recommended default: not permitted unless an event explicitly
  enables it**, consistent with #216's framing that self-release eligibility is
  "represented only where the approved policy permits and remains
  event/date-specific." This ADR should not set an age threshold — that's a
  policy call for ministry operations and safeguarding, not a default to infer.

### 3. Restricted/prohibited release records and custody-conflict handling

**Recommended:** custody-sensitive restrictions are stored separately from
ordinary pickup authorization, with their own dedicated permission — an
ordinary pickup-desk volunteer sees only an actionable allow/restrict/escalate
status, never the underlying reason or source document (matches #216's scope
exactly). Duplicate or overlapping declarations — two guardians each claiming
sole authority, for example — route to a restricted staff review queue rather
than being resolved automatically. Software does not adjudicate a custody
dispute; it surfaces the conflict and blocks release until a designated
reviewer acts.

**Open question:** who is the designated reviewer role for a custody conflict
or a restricted-release match at the actual point of release (a name/role, not
"staff" generically), and what is the escalation path when that reviewer isn't
immediately reachable during an active pickup?

### 4. Staff permissions, elevated override, and after-use review

**Recommended:** release requires ordinary staff permission for a normal,
unrestricted, verified pickup. An **elevated override** — releasing despite a
duplicate/stale/revoked/restricted signal — requires a distinct, harder-to-hold
permission, a declared reason, and (per #217's scope) a second-person approval
where policy requires it. Every override is reviewed after use, not just
logged. This mirrors the break-glass pattern proposed for protected records in
ADR 0005 §3, and the two should likely share the same audit and review
mechanism rather than building two.

**Open question:** does every override require second-person approval, or only
overrides that touch a restricted/custody-flagged record? #217 leaves this as
"where policy requires" — this ADR should say which cases those are.

### 5. Offline behavior, minimum fields, and outage runbook

**Recommended:** printable/offline pickup lists carry the minimum fields needed
to verify a release in the field (child identifier, authorized-recipient
identifier, scope/date, current status) and exclude anything not needed for
that decision — no medical detail, no full authority history, no unrelated
contact information. Offline release records reconcile idempotently against
the online system afterward, and duplicate offline entries for the same
release are detected and surfaced, not silently merged.

**Open questions:**
- Retention/disposal for the *paper or offline device copy itself* — this is
  separate from the retention question in §6 and easy to miss (a printed list
  left in a binder after the event is its own exposure).
- The outage runbook: what does staff do when neither the online system nor a
  printed list is current (e.g., a same-day revocation that happened after the
  list was printed)? Needs an explicit fallback, not an assumption that offline
  data is always current enough.

### 6. Retention, export, deletion, and notification content

**Not proposed here** — this is the item most clearly outside what an agent
should default. A minor-safety release record likely needs a different (and
plausibly longer) retention standard than ordinary registration data, for
reasons that are legal and safeguarding questions, not technical ones. This
ADR asks for a named answer rather than guessing:

- Retention period for release records, authority history, and custody-conflict
  records, and whether it differs by record type.
- Export rules — who may export release history, under what justification, and
  whether custody-sensitive content is redacted by default (recommended: yes,
  matching the same redaction default proposed for protected medical records in
  ADR 0005 §4).
- Deletion/anonymization procedure and legal-hold override.
- What a release or escalation notification may contain — recommended:
  status and identifiers sufficient to act, not full custody-conflict detail,
  matching the minimum-necessary-disclosure principle used throughout the
  roadmap (#98 rule 13).

## Consequences

- #216 and #217 can resume design/build work once this ADR is Accepted and
  reconciled into their scope — nothing here changes what those issues already
  describe; it resolves the open questions their own bodies flag.
- Keeping custody-sensitive restrictions in a separately permissioned record
  from ordinary pickup authorization (§3) means most pickup-desk staff never
  need access broad enough to see a restriction's underlying reason — smaller
  blast radius if a pickup-desk credential is compromised.
- Declining to default self-release age, override approval scope, and
  retention (§2, §4, §6) means this ADR cannot be Accepted by implementation
  work alone — it requires the named approvers below to actually decide, which
  is the point: these are safeguarding decisions, not defaults.
- Sharing an audit/break-glass mechanism with ADR 0005 (protected records)
  avoids building two parallel elevated-access review systems for adjacent
  problems.

## Alternatives considered

**Let household membership imply pickup authority.** Rejected — already ruled
out in #216's acceptance criteria. A shared last name or address is not a
custody decision, and treating it as one would be the single most likely way
this feature causes real harm.

**Let transportation arrival or event check-in imply eligibility for
release.** Rejected — #217 is explicit that these must remain independent
facts. A bus arriving is not a guardian being present.

**Resolve duplicate/conflicting guardian claims automatically (e.g., "most
recent wins").** Rejected — an automatic resolution rule is itself a custody
determination, which is explicitly out of scope for software to make (#215,
#216, #217 all state this as an exclusion).

**Skip the offline path and require connectivity for every release.**
Rejected as a default — residential/camp events are exactly the setting where
connectivity can't be guaranteed at the point of release, and treating that as
someone else's problem would push staff toward an unaudited workaround instead.

## Approvals needed (per #215's acceptance criteria)

This ADR is Accepted once each of the following signs off:

- [ ] Ministry operations owner
- [ ] Safeguarding/legal owner
- [ ] Privacy/security owner
- [ ] Event leadership owner

Open items that need a named answer, not just a checkmark, before Acceptance:

- [ ] Who may register a pickup authorization, and under what verification (§1)
- [ ] Acceptable in-person verification methods, and self-release age/policy,
      if any (§2)
- [ ] Named reviewer role and escalation path for custody conflicts (§3)
- [ ] Which overrides require second-person approval (§4)
- [ ] Offline-copy retention/disposal and the connectivity-outage runbook (§5)
- [ ] Retention, export, deletion, and notification-content rules (§6)

## Related

- Parent: #96 (authorized minor pickup, release, custody restrictions, and
  reunification)
- Blocks: #216, #217
- Depends on: #131 (declared guardian authority), #189/ADR 0005 (protected
  records — shared break-glass and redaction pattern)
- Related but independent: #206 (transportation status), #114 (emergency
  plans) — see #217's explicit non-implication rule above
- Roadmap: #98 (Phase 2G)
