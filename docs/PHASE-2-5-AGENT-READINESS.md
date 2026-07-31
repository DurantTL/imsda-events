# Phase 2–5 agent readiness index

Snapshot of which roadmap issues an automated build may claim, recorded
2026-07-31. GitHub issue #98 remains the canonical ordered roadmap and each
issue's own comments remain authoritative; this file is a navigational index so
an agent starting cold can find the frontier without reading sixty issues.

Labels carry the same meaning as elsewhere in the repository: `codex-ready`
marks a claimable frontier, and `specification-needed`, `needs-decision`,
`needs-human`, or `sensitive-data` mark work that is not ready for unattended
implementation. An epic is never claimable merely because a comment describes
implementation work in detail.

## How Phase 2 was unblocked

Most Phase 2 issues were held up by product answers nobody had supplied —
which rooms exist, which routes run, which meals are served, which discounts
apply. Those answers were reframed as **event-admin configuration** rather than
code, so the module can be built and reviewed now while the real values become
staff data entry later. This is the approach already recorded on #53 and #54.

Three modules need the append-only ledger from #74, which does not exist yet.
Rather than blocking them or writing into the existing `Payment` tables — which
would create the second ledger every financial guardrail prohibits — each
records immutable **charge intents behind a disabled posting adapter**:

| Issue | Deferred financial behavior | Unblocks at |
| --- | --- | --- |
| #80 | asset deposits, damage and replacement charges, waivers | #118 |
| #81 | meal charges, credits, walk-up sales | #118 |
| #100 | per-session fees | #118 |

The affected acceptance criteria stay open on those issues until the ledger
slice lands and one PR per module enables posting.

## The ledger (#74) and its slices

#74 was `codex-ready` but unclaimed, because it is eleven entity families plus a
live-data migration in one issue. The difficulty is not the ledger, it is that
`Registration.totalAmount` is a mutable column read in roughly 73 places —
including confirmation emails — overwritten by amendment repricing
(`modules/registrations/amendments-repository.ts`), with balance computed as
`totalAmount - paidCents` in `modules/registrations/repository.ts`.

The approach is a ledger built alongside, backfilled, and proven against the
existing number before anything switches over. The mechanism is a **shadow
reconciliation check** — `derived_balance == totalAmount - paidCents` for every
registration — kept green through every slice and retained afterward as a
standing invariant. `totalAmount` is not dropped; it becomes a projection.

| Slice | Scope |
| --- | --- |
| #117 | charge and credit entries, backfill, shadow reconciliation |
| #118 | payments and multi-registration allocations |
| #119 | refund allocations, disputes distinct from refunds |
| #120 | adjustments, scholarships, transfers, event credits |
| #121 | derived balance service and read-site cutover |
| #122 | processor settlement import and exceptions queue |
| #123 | event financial reconciliation report |

Downstream: #102 needs #117; #80, #81, and #100 need #118; #101, #67, and #92
need #120; #94 and #95 need #121; the Phase 1 release gate needs #123.
Installment schedules moved from #74 to #92, where the authorization and dunning
workflow they belong to lives.

## The ADR trio

#40 identity, #43 consent and guardian authority, and #44 protected records are
all `codex-ready` for documentation — no schema, no migration, no real data —
and all unclaimed. They are cheap and they gate a lot: #43 alone blocks #96
completely and constrains #91, #42, #78, #44, and #115. `docs/decisions/`
currently holds four ADRs and none of them covers identity, consent, or
protected records.

## Phase 2

| Issue | Claimable | Notes |
| --- | --- | --- |
| #41 club year and season roster | ADR only | policy decisions recorded; implementation follows ADR approval |
| #42 roster-to-event participation | ADR only | depends on #40/#41 ADRs |
| #68 CMMS unification | capability matrix only | needs read access to `DurantTL/CMMS-1` |
| #64 lodging | yes | inventory, night-by-night occupancy, roommate review, rooming lists |
| #89 attendee grouping | yes | build after #64; grouping never owns another module's capacity |
| #65 volunteer roles and shifts | yes | requirement types configurable and empty by default |
| #70 Sterling / NCS readiness | no | vendor access, sample export, status mapping — see #113 |
| #69 eAdventist verification | no | account, scope, privacy approval |
| #78 transportation | yes | excludes driver screening display, minor release, medical indicators |
| #100 session scheduling | yes | preserve the existing `ProgramAssignmentRun` chain |
| #81 meal service | yes | dietary projection stays disabled pending #44 |
| #80 issued assets | yes | key links to the lodging assignment, not the room |
| #93 staff recruiting | no | see #115 for the claimable slice |
| #96 minor pickup and custody | no | no separable slice; depends on #43 and on legal decisions |
| #79 incident and emergency ops | no | see #114 for the claimable slice |
| #102 promo code expansion | yes | non-stackable default, deterministic resolution |
| #113 NCS CSV import profile | yes | synthetic fixtures only |
| #114 emergency plans and offline reference | yes | split from #79; no incident or personal data |
| #115 worker requirement model | yes | split from #93; fail-closed, ships with no requirements configured |

## Phase 3–5

No Phase 3, 4, or 5 epic is claimable whole. Each issue carries a buildability
guide plus a claimable-slice review; the summary below is the short form.

| Issue | Slice claimable today | Principal blocker |
| --- | --- | --- |
| #62 passkeys | credential persistence, once a library is chosen | RP ID belongs in `PlatformSettings`; recovery needs security review |
| #91 reviewed prefill | field registry with never-carry-forward default | #40 identity model |
| #92 installments | none | #120; processor capability for unattended charges |
| #90 surveys and certificates | survey definition and identified-mode collection | certificate authority; anonymity needs its own sub-issue |
| #103 outbound API | **#124 credential model**, then public catalog endpoints | private partner API or public developer API |
| #82 mobile app | none | #103, #62, store accounts, framework ownership |
| #83 community expansion | per-event restriction controls | media, minor visibility, moderation capacity |
| #85 external portals | speaker and sponsor records as event content | where external-party identities live |
| #87 networking and lead capture | none | consent; recommend excluding events with minors |
| #94 camp store and POS | none | #121, #54; sales-tax obligation |
| #95 donations and funds | none | #121; tax receipting and designated-fund ownership |
| #86 virtual and hybrid | none | build after #100; buy streaming rather than build it |
| #97 personalization | none | build after #100/#89; input allowlist |
| #71 UltraCamp | none — #112 only | contract terms, #44, no confirmed readiness endpoint |

## Recommended order

1. **#117 then #118** — three Phase 2 modules unblock at #118, which is the
   fastest path from "nothing can post a charge" to "everything can."
2. **The ADR trio** — #40, #43, #44. Documentation PRs, no schema, and #43
   alone releases six issues. Can run in parallel with the ledger.
3. Phase 2 operational modules in roadmap order: #64, #89, #65, #78, #100,
   #81, #80, #102.
4. **#119 through #123** — the rest of the ledger, with #121 the one to treat
   carefully because it changes numbers attendees see.
5. #114, #115, and #124 — small, independent, and each unblocks a blocked epic.
6. #112 — closes the ADR-0002 conflict over UltraCamp ordering.
