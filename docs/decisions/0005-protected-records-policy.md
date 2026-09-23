# ADR 0005: Protected medical, allergy, and accommodation records — policy and encryption design

Status: **Proposed — draft for review.** Not yet Accepted. This is the deliverable
GitHub issue #189 asks for; the ADR becomes Accepted only once the named approvers
below sign off. Until then, #190–#192, #151, and the rest of #44 stay blocked, per
roadmap #98's rule that a protected-data child loses `codex-ready` while an
unsatisfied human gate controls its schema, disclosure, or retention.

Date: 2026-08-09

**Addendum A (club roster birth dates) is Accepted** as of 2026-09-22; see the end
of this document. It covers only roster birth dates. The rest of this ADR is
still Proposed.

## Context

Registration answers are stored today as plaintext JSON snapshots — no field-level
encryption, no separate access boundary for medical content beyond the ordinary
event-staff permission. Two prior internal reviews already flagged this as the
platform's outstanding pre-production risk:

- `docs/PRODUCTION-READINESS-REVIEW.md` §4: *"Medical, dietary, and screening
  answers are stored in plaintext JSON... For a conference collecting minors'
  medical information, this is a policy question as much as a technical one."*
- `docs/PRODUCTION-READINESS-PROGRESS.md` item 8: encryption was explicitly
  deferred beyond the Women's Retreat release as a scope decision, not because the
  underlying risk was resolved.

Some groundwork already exists in the codebase and should not be rebuilt:

- **`lib/secret-box.ts`** — AES-256-GCM authenticated encryption with a random
  96-bit nonce per value, keyed by HKDF over `SECRET_ENCRYPTION_KEY` with a
  per-purpose info string. Built for TOTP secrets but explicitly written to be
  reusable: two kinds of ciphertext are never encrypted under the same derived
  key, and a value can't be silently moved between columns. This is the primitive
  #190 (encrypted persistence) would use.
- **`modules/attendee-accounts/registration-answer-policy.ts`** — a
  `sensitiveFieldPattern` regex already matches
  `medical|medication|health|allerg*|dietary|accessib*|disabil*|special needs|
  emergency|guardian|minor|age|birth|gender|sex` against field key and label text,
  and the app already refuses self-service editing of anything that matches. The
  application layer already treats these as a distinct category; it just doesn't
  encrypt them yet.
- **`AttendeeAccount.dietaryNeeds` / `AttendeeAccount.accessibilityNeeds`** —
  plain, unencrypted `String?` columns holding self-disclosed convenience
  preferences. These are lower sensitivity than clinical answers collected on a
  registration form and are called out separately below (§1) so this policy
  doesn't accidentally treat "no nuts, thanks" the same as a medication list.
- **`modules/audit/audit-service.ts`** — a working audit log
  (`actorUserId`, `entityType`, `entityId`, `correlationId`, `summary`, `metadata`)
  that break-glass access and disclosure events can write to without new
  infrastructure.
- **ADR 0003** already anticipated this: *"Medical information, club rosters
  (when built) ... enrolment becomes required to reach either. That is a scope
  rule: the factor is required by what is being touched, not by who is
  touching it."* This ADR should stay consistent with that precedent rather than
  re-deciding it.

Nothing below authorizes storing, migrating, or displaying real protected data.
Per #189's acceptance criteria, production implementation and migration stay
disabled until this ADR is Accepted.

## Decision

Each subsection below is one of the "human decisions required" from #189. Where a
reasonable default exists, it's proposed explicitly and marked **Recommended** —
approve, replace, or strike it. Nothing here is final until it's checked off.

### 1. Protected data classes and purposes

Proposed classes, each independently scoped:

| Class | Examples | Notes |
| --- | --- | --- |
| Clinical/medical | Diagnoses, medications, treatment instructions | Highest sensitivity |
| Allergy / safety-relevant dietary restriction | Food allergy, epi-pen requirement | Kitchen/medical staff need a status flag, not the note |
| Accommodation / accessibility need | Mobility, sensory, communication support | Lower sensitivity than clinical but still restricted |
| Mental-health / behavioral note | — | Highest sensitivity; narrowest access |
| Custody-adjacent note | Restricted pickup, safety flag | Shared boundary with #215/#216; cross-reference, don't duplicate storage |

**Recommended:** collect severity/category through structured fields (checkbox,
select, short flag) wherever the workflow allows, and reserve free text for detail
that genuinely can't be structured. A checklist is easier to make a status
indicator out of (§3) than a paragraph is, and it's what limits what an
autocomplete, export, or log line can leak by accident.

`dietaryNeeds` / `accessibilityNeeds` on `AttendeeAccount` are **out of this
class** — self-disclosed convenience preferences, not clinical content. Leave
them unencrypted unless an approver wants otherwise; encrypting them buys little
and would slow down every legitimate menu/accommodation lookup.

**Decision needed:** confirm this class list and the boundary between
"convenience preference" and "protected record" — the table above is a starting
point, not a ruling.

### 2. Encryption design, key custody, rotation, recovery

**Recommended:** extend `secretBox` rather than build a second primitive.
Concretely: seal each protected answer value with `sealSecret(value, purpose)`
where `purpose` encodes the field class (e.g. `registration-answer:medical`), so
a leaked key-derivation purpose for one class can't decrypt another. This mirrors
the "never the same key twice" property the module already documents.

Two open implementation questions this ADR should settle before #190 starts:

- **Granularity.** Seal each protected field independently (more granular access
  control, more ciphertext blobs) vs. seal one JSON envelope per registration
  containing every protected answer (simpler, but an authorized read for one
  field discloses the whole envelope). **Recommended: field-level sealing** — it's
  what lets §3's status-only disclosure work without decrypting content nobody
  asked to see.
- **Searchability.** AES-GCM ciphertext isn't searchable. If staff need to filter
  "who has a listed allergy," that has to be a separate unencrypted boolean flag
  maintained alongside the sealed value, not a query over ciphertext.
  **Recommended:** yes — maintain a `hasProtectedFlag` boolean per class,
  updated when the sealed value is written, never containing content.

**Key custody — needs a named answer, not a default:**

- Does protected-record data get its own `SECRET_ENCRYPTION_KEY`-derived purpose,
  separate from TOTP and other existing secrets? **Recommended: yes** — the HKDF
  purpose string already makes this free; there's no reason to share a
  derivation path with an unrelated secret class.
- Who holds and rotates the production key, and through what channel (env var via
  the deploy secret store, as today, or a KMS)? **Not proposed here** — this is
  the actual custody decision and needs a named key-operations owner.
- **Recovery is the risk to name explicitly:** AES-GCM is authenticated
  encryption by design — losing the key makes every sealed value permanently
  unrecoverable, not just hard to read. A backup/escrow procedure for the
  encryption key itself (distinct from the database backup) needs to exist
  before any real protected data is written, or a lost key becomes a
  permanent-deletion event nobody chose.
- Rotation cadence and the re-seal procedure when it happens (re-sealing requires
  the old key to decrypt and the new key to re-encrypt — plan for both being
  available during a rotation window).

### 3. Access authority: subject, guardian, staff, disclosure, break-glass

**Recommended**, consistent with ADR 0003's existing precedent and #191's
acceptance criteria:

- Reading or editing a protected field requires a **dedicated permission**,
  distinct from ordinary event-staff access — "can see the roster" must not imply
  "can see medical notes." No generic event-staff role gets this by default.
- Registration owner (subject/guardian, once #125–#132 identity/consent exist)
  can view and correct their own answers under the same enrolled-second-factor
  requirement ADR 0003 already established for "medical information, club
  rosters."
- **Status-only disclosure:** operational roles that need to *act* on a flag
  (kitchen staff, session/activity staff, transport) get a boolean/severity
  indicator only — "has a listed allergy," not the note itself. This is what
  §2's separate flag column is for.
- **Break-glass:** elevated permission, a declared reason, a bounded time window,
  immediate notification to a designated reviewer where approved, and mandatory
  after-use review. Every read, write, denied attempt, and break-glass action
  writes to `modules/audit`'s existing `writeAuditLog` — reads and denials, not
  only mutations, per #191's acceptance criteria.

**Decision needed:** name the roles that get the dedicated protected-data
permission, and who reviews break-glass usage after the fact.

### 4. Sharing across events, correction, retention, export, deletion

- **Cross-event sharing: recommended default is no automatic sharing.** A
  protected answer given for one event does not carry to another without an
  explicit, reviewed re-confirmation — matching roadmap principle 13 ("a roster,
  readiness status, assignment... must never silently grant access to another
  domain") and staying compatible with the later returning-profile work
  (#226–#228), which is explicitly a *reviewed* prefill, not a silent copy.
- **Correction:** a new version, preserving what was previously known and when —
  same pattern the consent slices (#129–#132) already use. No protected answer is
  overwritten in place.
- **Retention and deletion:** needs a named schedule. **Not proposed here** —
  this is a legal/safeguarding question (how long must a medical record for a
  minor be retrievable after an event, independent of ordinary registration
  retention?) and shouldn't be defaulted by an agent.
- **Export:** any export containing protected content requires a named
  justification and is itself audited; no bulk unredacted CSV without a separate,
  explicit confirmation step. The existing retreat report-packet builder already
  excludes free-text protected answers from printed packets
  (`docs/PRODUCTION-READINESS-REVIEW.md` §10) — this ADR should keep that
  exclusion as the default for every future report, not just the one already
  built.
- **Legal hold** overrides normal deletion; needs the same named owner as
  retention.

### 5. Existing protected-field inventory (metadata only)

Per #189's requirement — no protected values in GitHub, keys and labels only:

- The application-layer pattern already in production is
  `modules/attendee-accounts/registration-answer-policy.ts`'s
  `sensitiveFieldPattern`, matching field key/label text against
  `medical|medication|health|allerg*|dietary|accessib*|disabil*|special needs|
  emergency|guardian|minor|age|birth|gender|sex`. This is the closest thing that
  exists today to an inventory rule, and #190/#191 should keep using it (or its
  successor) as the single source of truth for "is this field protected," rather
  than a second, divergent list.
- `AttendeeAccount.dietaryNeeds` and `AttendeeAccount.accessibilityNeeds` are the
  only protected-adjacent *columns* in the schema today (see §1 on why they're
  classed separately); everything else sensitive currently lives inside the
  JSON response blob on a registration/attendee snapshot, keyed by whatever field
  key the event's form template assigned.
- Actual per-event field keys and labels (never answer values) live in each
  event's form template configuration in the database, not in committed code —
  templates are authored per event, not hardcoded. Producing a live inventory
  means running a metadata-only query (`sensitiveFieldPattern` matched against
  configured field keys/labels, values excluded) against a real or seeded
  database, not something derivable from the repository alone. **This ADR
  recommends that query be written as part of #190's implementation and run by
  someone with database access** — it isn't run here, and no protected values or
  even field labels from a real event are included in this document.

### 6. Synthetic verification, migration dry run, rollback

- All verification for #190–#192 uses synthetic fixtures, per the repository's
  standing rule against real protected data in tests or fixtures — no exception
  for this feature.
- **Migration dry run:** seal existing plaintext protected fields in a
  reversible window — old plaintext value retained alongside the new sealed
  value until a human confirms decrypted round-trips match for every seeded
  registration, then plaintext is removed. This mirrors the ledger cutover
  pattern already used elsewhere in the roadmap (#121's shadow-check-before-flip
  approach): don't delete the fallback until the new path is proven equal.
- **Rollback:** if the sealed read path fails after cutover, the forward fix is
  to repair the sealing/keying bug, not to silently fall back to plaintext.
  Once real protected data has been sealed and the plaintext copy removed, there
  is no safe rollback to "just read it in the clear again."
- Production migration itself remains a named human action, consistent with
  every other production-migration gate in this roadmap.

## Consequences

- #190–#192 and #151 stay unblocked technically (they can be built and tested
  against synthetic fixtures) but stay off `codex-ready` for production
  activation until this ADR is Accepted, matching roadmap rule 16.
- A field-level sealing design means access control can be genuinely
  field-scoped later (e.g., dietary status visible to kitchen staff without
  clinical notes), rather than an all-or-nothing envelope.
- Naming a separate HKDF purpose for protected records costs nothing today but
  avoids ever having to explain why a medical record and a TOTP secret shared a
  derived key.
- The unresolved items (named key-operations owner, rotation cadence, retention
  schedule, legal hold owner) block Acceptance. They are policy decisions, not
  implementation gaps, and are called out rather than defaulted.

## Alternatives considered

**Rely on disk/volume encryption alone.** Rejected — already flagged as
insufficient in `docs/PRODUCTION-READINESS-REVIEW.md` §4; it protects against a
stolen disk, not against a database credential leak or an overbroad query, and
does nothing for the field-level and role-based access control #191 requires.

**One sealed JSON envelope per registration instead of per field.** Rejected as
the default: simpler to implement, but it means any authorized read of one
protected field discloses every protected field on that registration, which
works against the status-only disclosure requirement in §3.

**A second, independent encryption primitive instead of extending
`secret-box.ts`.** Rejected — the existing primitive is already
purpose-separated and reusable; building a second one would mean two encryption
schemes to audit and rotate instead of one.

**Default a retention period rather than escalate it.** Rejected — retention for
a minor's medical record is a legal/safeguarding question with real consequences
either way (too short loses evidence that might matter later; too long is its
own liability), and shouldn't be picked by an agent drafting a proposal.

## Approvals needed (per #189's acceptance criteria)

This ADR is Accepted once each of the following signs off, in a comment on this
PR/issue or a recorded decision elsewhere this doc can cite:

- [ ] Privacy owner
- [ ] Security owner
- [ ] Legal/policy owner
- [ ] Ministry operations owner
- [ ] Key-operations owner (production key custody, rotation, backup/restore)

Open items that need a named answer, not just a checkmark, before Acceptance:

- [ ] Confirm or revise the protected data classes in §1
- [ ] Name the production key custodian and rotation cadence (§2)
- [ ] Approve the key-loss/backup-escrow procedure before any real data is sealed (§2)
- [ ] Name the roles with the dedicated protected-data permission, and the
      break-glass reviewer (§3)
- [ ] Set the retention/deletion schedule and legal-hold owner (§4)

## Related

- Parent: #44 (protected medical, allergy, medication, and accommodation records)
- Blocks: #190, #191, #192, #151
- Depends on: #125–#132 (identity, guardian, and consent foundations)
- Roadmap: #98 (Phase 2C)

---

## Addendum A: Club roster birth dates

Status: **Accepted.** Approved by Caleb Durant, Communication Director, on
2026-09-22 (GitHub issue #355). Applies to H2 (#356) and the club slices that read
the roster (H3, H5). It does not approve medical, insurance, or
background-check data. Those stay off rosters until the rest of this ADR is
Accepted.

### Why

Club rosters record a birth date for each person so that age is correct for
minimum-age honors, attendee type, and later club years. Most of these people
are minors. Registration answers are stored unencrypted today (see Context), so
birth dates need their own protection.

### Decision

1. **Encrypted at rest.** The birth date is stored only as ciphertext, using
   `sealSecret` from `lib/secret-box.ts` with its own purpose string
   (`club-roster:birth-date`). It is never written to registration answers,
   audit summaries or metadata, logs, analytics, error reports, or fixtures.
2. **Minimum necessary.** Eligibility, attendee type, reports, exports, and
   check-in use the **age on the event date**, computed on the server. Screens
   that do not need the full date never receive it.
3. **Who sees the full birth date** (decided 2026-09-22):
   - that club's own directors and deputies with an active grant (H1); and
   - system administrators.

   No one else sees it, including event staff with `VIEW_SENSITIVE_DATA`
   (registration managers, finance, and check-in staff). They see age only.
   Every reveal or export of full birth dates is audited, without the date
   itself.
4. **Scoped access.** A director reaches only their own club's people. Tests
   prove that other clubs' people, counts, and search results never leak, and
   that a club the person does not direct answers 404.
5. **MFA.** An account must have MFA turned on before it can open a club roster
   (the account page already tells attendees this). System administrators
   already require MFA.
6. **Retention is the club's decision, not the conference's.** Club members
   often stay on as staff for many years, so there is **no automatic deletion or
   expiry**. The roster keeps a person, active or inactive, until that club's
   director removes them:
   - **Deactivate** keeps the person and their history (for example, someone
     who may return, or who moves from Pathfinder to staff). Changing a
     person's role over the years is an edit, not a new record.
   - **Remove** erases the birth date and personal fields. The audit keeps only
     the fact that the person was removed, and by whom.

   Not decided yet: what happens to a closed club's roster, or one with no
   director. Raise it when it first comes up.
7. **Key custody** (decided 2026-09-22):
   - **Custodian: Jonathan Swena.**
   - A copy of the production `SECRET_ENCRYPTION_KEY` is kept on an **external,
     on-premises server, not a cloud service**. That backup does not exist yet.
     Building it is an open item on the server checklist
     (`docs/SERVER-SECURITY-CHECKLIST.md`).
   - Losing the key loses every birth date permanently. **No real birth date
     may be stored until the key copy exists and has been test-restored.**
   - The key copy is kept apart from the database dumps. A single machine that
     holds both would let anyone who took it read everything.
   - Rotation follows §2 above: re-seal while both keys are available. The
     custodian writes the step-by-step procedure as part of the checklist.
8. **Around the database.** The items on `docs/SERVER-SECURITY-CHECKLIST.md`
   must be complete before real directors enter birth dates. H2 may be built,
   tested, and merged with synthetic data before then.

### Consequences

- H2 can be built now (`codex-ready`). Going live for real directors is gated
  by the server checklist, not by further sign-off.
- `SECRET_ENCRYPTION_KEY` becomes irreplaceable data, not just configuration.
- The same sealing pattern is the model for the protected records in the rest of
  this ADR, without approving them.
