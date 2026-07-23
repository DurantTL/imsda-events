# Build-plan gap analysis

Compares the staged **IMSDA Events — First Build Prompt and Implementation Plan** (phases 0–9)
against the current `imsda-events` implementation, verified by a full runtime pass on
2026-07-23 (install, PostgreSQL 16, migrate/seed, lint, typecheck, 402 unit tests, production
build, and the 4 live public-registration checks — all green).

## Headline

The repository is **far beyond the plan's "first prompt" (Phase 0)**. The first prompt told the
agent to stop after the foundation; in practice the codebase has substantially completed
**Phases 0, 1, 4, and 5**, mostly completed **Phase 2**, and partially completed **Phases 3, 6, 7,
and 8**. **Phase 9 (hardening & cutover)** is essentially untouched. The build order is sound and
the "complete" areas are backed by real, tested code — the remaining work is breadth
(more of the data model, communications, attendee app, integrations) and production hardening.

## Phase-by-phase status

| Phase | Area | Status | Notes |
| --- | --- | --- | --- |
| 0 | Repository foundation | ✅ Done | Scaffold, App-V2-style shell, schema baseline, CI, local PostgreSQL. |
| 1 | Access foundation | ✅ Done | scrypt auth, password reset, event memberships, capability checks, role-matrix tests. |
| 2 | Multi-event backend | 🟡 Mostly | Event-scoped, transactional, audited, permission-tested APIs. **Gaps below.** |
| 3 | WR26 staging migration | 🟡 Partial | Idempotent CSV staging import + reconciliation + exceptions + source snapshots. **No live WR26 (GAS/Sheets) source adapter** — import is via uploaded CSV. |
| 4 | Event-manager operations | 🟡 Mostly | People/registrations/manual payments/check-in/exports/dashboards, QR + manual + partial-party check-in + undo + offline queue, seminar assignment preview/run/roster. **Gap:** printable rosters/meal counts; exports are CSV only (no Google Sheets). |
| 5 | Registration builder | ✅ Done | 7 templates, sections/fields, conditional logic, pricing, preview/test, publish/versioning. **Gap:** file uploads, signatures, some Release C/D modules and cross-event template governance. |
| 6 | Communications | 🟡 Partial | Announcements draft/publish + public all-attendee feed; 13 versioned templates, outbox, Resend, retry/backoff, delivery logs. **Gaps below.** |
| 7 | Attendee application | 🟡 Partial | QR passes + private manage portal (view registration, balance, pay, contact edits). **No dedicated attendee app.** |
| 8 | Integrations | 🟡 Partial | Square (Sandbox) + Resend, signed webhooks, messaging outbox, retry/backoff. **Other adapters + generic sync outbox not built.** |
| 9 | Hardening & cutover | 🔴 Not started | Offline check-in exists; backups/monitoring/retention/encryption/cutover rehearsal do not. |

## What needs to be done (prioritized)

### 1. Complete the Phase 2 data model (plan §4.2, §4.4)
The plan's permanent-people and financial models are only partially realized.
- **People/org domain — not built:** `Organization`, `PersonAffiliation`, `ExternalIdentity`, and
  versioned **Consent/compliance** records. The schema has only `Person`, `Household`,
  `HouseholdMember`. (`modules/people/` is currently a documentation-only boundary — no source —
  which accurately reflects that this domain is still backlog.)
- **Financial ledger — design decision:** the plan (§4.4) explicitly warns against a single
  payment id/status on the registration and asks for `Order`/`OrderItem`, `Discount`,
  `PriceAdjustment`, and an append-only balance. Current code has `Payment`, `PaymentAttempt`,
  `Refund` and derives balance from pricing snapshots + promo redemptions. Decide whether to keep
  the derived-balance model or introduce the ledger before more finance features land.

### 2. Communications expansion (Phase 6, plan §4.7)
Already documented as later work; concretely: **targeted/scheduled audiences** (only
`ALL_ATTENDEES` reaches the public feed today — the `Announcement.audience` JSON + `placement` +
`priority` columns exist but the targeting/scheduling logic does not), an **approval workflow** for
urgent/organization-wide messages, **SMS/push adapters**, and **unsubscribe/preferences/suppression**.

### 3. Attendee application (Phase 7, plan §4.8)
Beyond the manage portal + QR pass: a mobile attendee experience with **schedule, seminar
assignments view, venue maps, meals/lodging, saved schedule, emergency info**, and an
**announcements/urgent-alert feed** for attendees. Community features only after moderation/privacy.

### 4. External integrations (Phase 8, plan §4.9)
Only Square + Resend exist. Build **adapters** for WordPress, FluentCRM, Google Sheets, UltraCamp,
eAdventist, and Sterling, plus a **generic integration outbox + retryable sync worker** (the current
outbox is messaging-only). Per the guardrail, these must never block a core registration transaction.

### 5. Hardening & cutover (Phase 9, plan §5.4–5.7)
Automated **backups + restore testing**, **error monitoring/alerting**, **structured logs with
correlation IDs and redaction**, **data retention/deletion/export** procedures, **field-level
encryption** for medical/insurance/screening data, documented **staging/production separation**, and
a **go-live checklist + cutover rehearsal**. Health checks exist for app + DB but not for queues/adapters.

### 6. Event-day release gate (near-term, already flagged in BUILD-STATUS)
**Printable attendee passes and group/meal rosters** — the current event-day release gate.

### 7. Optional: WR26 live source adapter (Phase 3, backlog #6)
If a direct read-only pull from WR26 GAS/Sheets is still wanted (rather than CSV export → import),
build that source adapter; otherwise document CSV-upload staging as the accepted approach.

## Note on plan framing
The plan's "first build prompt" and ADR 0001 describe the Phase-0 foundation and say the first slice
has "no authentication, payment collection, import, or external write path." The repo has advanced
well past that point. The ADR is a point-in-time record and is left as-is; this document is the
current-state view.
