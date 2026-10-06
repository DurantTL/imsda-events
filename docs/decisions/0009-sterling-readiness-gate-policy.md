# ADR 0009: NCS Risk/Sterling readiness production gate policy

Status: **Proposed — draft for review.** Not yet Accepted. Deliverable for
#218. Production import/apply and disclosure stay disabled until Accepted,
per #218's own acceptance criteria — this ADR does not itself enable anything.

Date: 2026-08-09

## Context

#218 sits downstream of two already-well-specified technical slices: #113
(configurable NCS Risk CSV import profile) and #115 (provider-neutral worker
requirement/checklist model), both `codex-ready` and unbuilt. #113's own issue
body already records several owner decisions this ADR should treat as settled
rather than re-litigate: NCS/Sterling is the next integration priority; the
current approved CSV is the initial source schema; unknown columns are ignored
by default and shown in preview; prohibited report details (SSN, criminal-
history detail, narratives, adjudication notes, documents) are never persisted
regardless of what future exports add.

The reusable machinery already exists: `ImportRun` and `ImportRecord`
(`prisma/schema.prisma`) already model batch provenance (`sourceSystem`,
`sourceRunKey`, checksum, created/updated/skipped counts) and per-row status
with `rawSnapshot`/`normalizedData`/`differences`/`warnings`/`errors` — this is
the same infrastructure the WR26 legacy import already uses
(`modules/imports/wr26-bundle.ts`), and #113 should extend it with
`sourceSystem: "NCS_RISK"` rather than building parallel infrastructure.
`ExternalIdentity` already reserves a provider slot for Sterling Volunteers
(`modules/organizations/README.md`), so the stable-subject-ID matching #113
requires has a model to attach to.

What remains genuinely undecided — and is the actual content of this gate —
is the specific status mapping, disclosure wording, and production runbook,
none of which #113 or #115 decide because they're explicitly out of scope for
those issues.

## Decision

### 1. Status normalization mapping

#218 requires approving the exact mapping from NCS/Sterling's native status
values into IMSDA's provider-neutral states: `SATISFIED`, `PENDING`,
`ACTION_REQUIRED`, `EXPIRED`, `NOT_VERIFIED`, `ERROR`. **This ADR cannot
propose the actual mapping table** — it depends on the real NCS/Sterling export
column values, which this ADR has no access to and shouldn't guess at (a wrong
guess here fails silent, not loud, since #113 already requires unmapped values
to fail closed rather than default to a state). **What this ADR proposes:**
whoever produces the synthetic/redacted CSV sample #218 asks for should
produce the mapping table alongside it, and the fail-closed rule (unmapped or
stale → `ERROR`/`NOT_VERIFIED`, never assumed `SATISFIED`) is confirmed as
non-negotiable regardless of what the mapping turns out to be.

### 2. Stable matching identifier

**Decision needed:** #113 already prohibits name-only matching and requires a
stable external ID. Confirming which column that is requires the real CSV
layout — another item that depends on the sample being provided, not something
this ADR can default.

### 3. Disclosure and notification wording

**Recommended:** operational roles (event staff scheduling a worker, a roster
lead checking readiness) see only the provider-neutral status
(`SATISFIED`/`PENDING`/`ACTION_REQUIRED`/etc.) and, where applicable, an
expiration date — never a report narrative, adjudication detail, or
NCS-native status text. This mirrors ADR 0005's status-only disclosure
principle for protected medical data, applied to screening readiness instead.

**Decision needed:** exact notification wording for `ACTION_REQUIRED` and
`EXPIRED` states — what a worker or their supervisor is told, and whether the
notification names the requirement (e.g., "background check") without naming
the provider or process detail.

### 4. Field allowlist, retention, and refresh cadence

**Recommended, consistent with #113's existing denylist:** persist only the
conceptual fields #113 already lists (external ID, name/email as match
evidence only, org/program scope, requirement identifier, normalized status,
completion/expiration dates) — never the prohibited categories #113 already
excludes.

**Decision needed:** retention period for readiness records after a worker's
assignment/event ends, and refresh cadence (how often is a new export
imported — per event cycle, monthly, on demand?). Not proposed here; this is
an operational/compliance decision, not a technical default.

### 5. Real-export preview, reconciliation, and production activation

**Recommended process, matching #113's acceptance criteria:** a real export is
first run through preview/reconciliation without being applied, ambiguous
matches are resolved by a named reviewer (not auto-linked), and only after
that review does a human separately approve production activation. Preview and
activation are two distinct approvals, not one — a clean preview does not
imply consent to apply it.

### 6. Outage and manual fallback

**Decision needed:** the manual export/upload runbook, expected import
frequency, and what staff do if an import is overdue or fails (e.g., can an
event proceed with stale-but-not-expired readiness data, or does an overdue
import become its own `ACTION_REQUIRED`-equivalent escalation?). Not proposed
here — this is an operational continuity decision for whoever owns the
Sterling relationship day to day.

## Consequences

- #113 and #115 can be built now against synthetic fixtures regardless of this
  ADR's status — they don't depend on the real mapping, only on the shape of
  the provider-neutral contract, which #113 already specifies.
- The unresolved items (real mapping table, stable ID column, retention,
  refresh cadence, outage runbook) all require an artifact this ADR can't
  produce on its own: a real or faithfully redacted CSV sample and someone who
  owns the Sterling relationship operationally. This ADR names exactly what's
  needed from them rather than guessing.
- Reusing `ImportRun`/`ImportRecord` instead of new tables keeps NCS/Sterling
  import auditing consistent with the WR26 import already in production.

## Alternatives considered

**Guess at a plausible status mapping now so #113 has something concrete to
target.** Rejected — #113 already requires unmapped values to fail closed, and
a guessed mapping that's later wrong would either silently mis-classify a
worker's readiness or require every already-imported row to be re-evaluated.
Better to build #113's configurable mapping *mechanism* now and supply the real
table when it exists.

**Build a new import model instead of extending `ImportRun`/`ImportRecord`.**
Rejected — the existing model already carries the provenance, preview, and
reconciliation shape #113 asks for; a parallel model would mean two things to
audit instead of one.

## Approvals needed

- [ ] Provide a current synthetic or irreversibly redacted CSV sample and the
      stable matching column (operational owner — cannot be produced by this ADR)
- [ ] Approve the exact status mapping table once the sample exists
- [ ] Ministry operations / worker-readiness owner (disclosure wording,
      retention, refresh cadence)
- [ ] Privacy/security owner (field allowlist, credential/file custody)
- [ ] Incident-response owner (outage/manual fallback runbook)

## Related

- Parent: #70 (Sterling Volunteers readiness integration)
- Depends on: #113, #115
- Related: #76 (shared import/reconciliation), #42 (participation readiness)
- Roadmap: #98 (Phase 2A)
