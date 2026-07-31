# Platform specification coverage

Section-by-section audit of the reusable-platform specification against the
repository as it stands, 2026-07-31. Every claim below was checked against
source, not against the issue tracker.

Companion to `PHASE-2-5-AGENT-READINESS.md`, which covers claimability. This
file covers **what exists**.

## Headline

The platform is substantially further along than a roadmap read suggests: 96 API
route handlers, 25 workspace pages, 161 test files, and a schema with 63 models.
Registration, payments, communications, check-in, imports, audit, permissions,
and the public and self-service experiences are real and tested.

The gaps are concentrated in three places:

1. **Operational domains that do not exist at all** — lodging, meals, sessions
   with schedules, merchandise, documents and waivers. Each has an issue.
2. **The financial model**, which cannot express the specification's history
   requirement until the ledger lands. Has issues (#117–#123).
3. **Foundations nobody has filed** — the pricing engine, configurable attendee
   types, notes and tags, several form field types, and event templates. These
   had **no owning issue** before this audit.

The third category is the important finding. Several Phase 2 issues assume
these foundations exist.

## Section-by-section

Legend: **Built** — working and tested. **Partial** — real but materially short
of the specification. **Absent** — no implementation.

| § | Area | State | Evidence and gap |
| --- | --- | --- | --- |
| 1 | Core event setup | Partial | `Event` has name, slug, dates, timezone, location, capacity, support contact, registration open/close, waitlist flags. **Absent:** theme, description, visibility model (public/private/invitation-only/staff-only/hidden — only `isPublished` exists), lifecycle modes beyond published (#72), clone (#72), attendee types/categories/tracks/departments as configuration, branding colours (#84). |
| 2 | Registration forms | Partial | 12 field types, conditional questions, `REGISTRATION`/`ATTENDEE` scope for household-vs-attendee questions, repeating attendee sections, admin-entered registrations, per-choice capacity. **Absent:** address, file upload, signature, acknowledgment field types; save-and-resume (#73); duplicate detection (#126). |
| 3 | Registration structures | Partial | Individual and household work. Group/club/church leader workflows, invitations, and bulk admin registration are #73 and #67. |
| 4 | Attendee records | Partial | `RegistrationAttendee` carries type, position, profile snapshot, form responses; `RegistrationOperation` gives a timeline with before/after snapshots and actor. **Absent: internal notes and tags/flags — no model of any kind.** |
| 5 | Pricing engine | **Partial — the largest unfiled gap** | Pricing is entirely form-field-derived (`priceCents` per field, per-choice prices, `latePricing` with a single date threshold, processing fee, line-item breakdown). **Absent:** attendee-type-based pricing, more than two date tiers, lodging by night, meal plans, session fees, merchandise, group discounts, household maximums, complimentary registrations, deposits, admin overrides, scholarships, tax, post-registration charges, prorating. Amendments overwrite `Registration.totalAmount`, so price history is not preserved. |
| 6 | Payments and accounting | Partial | Square card payments, cash/check/manual, refunds, webhooks with idempotency, payment attempts with client and provider idempotency keys, `RegistrationPaymentChoice`. **Absent:** charges, allocations, one payment across registrations, deposits, disputes, fee tracking, reconciliation — all #117–#123. |
| 7 | Promo codes | Built, extension filed | `PromoCode`, `PromoCodeRedemption`, fixed and percentage, date windows, total-use caps with concurrency protection, redemption history preserved. #102 adds restrictions, personalised codes, automatic discounts, stacking. |
| 8 | Seminars and activities | Partial | `RANKED_CHOICE` fields, `ProgramAssignmentRun`, `ProgramAttendeeAssignment`, supersession chain, capacity, rosters. **Absent:** schedules, rooms, speakers, restrictions, prerequisites, fees, conflicts, session waitlists, attendance — #100. |
| 9 | Lodging | Absent | Registration answers and `retreat-packets` reports only. No inventory, assignment, or occupancy. #64. |
| 10 | Meals | Absent | Registration answers and report counts only. #81. |
| 11 | Merchandise | Absent | `Event.collectsShirtSizes` plus a shirt-size request template. No products, variants, inventory, or orders. #54. |
| 12 | Waitlists | Partial | `RegistrationWaitlistEntry` with `WAITING`/`PROMOTED`/`REMOVED` and auto-promotion. **Absent:** offer sent, offer expiry, accepted, declined states; lodging, session, and meal waitlists. |
| 13 | Changes and transfers | Built | `RegistrationOperation` with `TRANSFER`, `ATTENDEE_SUBSTITUTION`, `AMENDMENT`, before/after/response snapshots, actor, and request fingerprint for idempotency. Meets the specification's TransferLog requirement. |
| 14 | Cancellations and refunds | Partial | Refunds and lifecycle actions exist; the policy engine, self-service requests, and event credits are #101. |
| 15 | Check-in | Built | `CheckIn`, signed PII-free QR passes, scanner, badge labels, resolve endpoint, undo with audit. **Absent:** offline mode, on-site payment, walk-in registration at the desk. |
| 16 | Communications | Built | Durable `MessageOutbox` with attempts and provider events, versioned templates, per-event sender settings, retry, bounce tracking, broadcasts, balance reminders. Among the strongest areas. **Absent:** SMS, scheduled sends and segmentation (#77), attachments. |
| 17 | Documents and printables | Partial | Badge labels, packets, operational reports, CSV export. **Absent:** configurable templates, invoices, meal tickets, lodging cards, door signs, manifests. |
| 18 | Admin dashboard | Partial | `overview` page and readiness reports. **Absent:** most of the specification's tile list, because the underlying domains do not exist yet; clickable drilldown is #75. |
| 19 | Search and saved views | Partial | Attendee matching and roster CSV exist. Combinable filters, saved views, and bulk actions are #75. |
| 20 | Imports and exports | Built for WR26 | `ImportRun`/`ImportRecord`, CSV parser, preview, exceptions, reconciliation, commit, cleanup, and a WR26 bundle covering the related historical tables. #76 extends to remaining domains. |
| 21 | Audit and historical integrity | Built | `AuditLog` plus operation snapshots. **The one systemic exception is financial:** `Registration.totalAmount` is overwritten by amendments, so how a balance was reached is not fully recoverable. That is exactly what #117–#121 fix. |
| 22 | Roles and permissions | Partial | `EventRole` (6 roles), `EventPermission` (11 permissions), per-event membership, `GlobalRole`, tested authorization. **Absent:** lodging, seminar, and meal coordinator roles; group/church leader role (#110); audit-log and deletion permissions. |
| 23 | Privacy, security, reliability | Built | MFA for staff and attendees, sessions, step-up, rate limiting, breach and denylist password checks, encrypted secrets, CSP tests, webhook retries, idempotency on payments and registrations, health checks, request security tests. Protected medical handling is #44. |
| 24 | Public registration experience | Built | Multi-step public form, validation, review step, embed, waitlist, recovery, confirmation. |
| 25 | Self-service portal | Built | Manage-by-token and attendee account portals, answer updates under `AttendeeEditPolicy`, payment, QR retrieval, profile. |
| 26 | API and integrations | Partial | Square, Resend with webhooks, Google OAuth, embeds. Outbound public API is #103 and #124. |
| 27 | Event templates | **Absent as data** | Templates exist, but **as hard-coded TypeScript** in `modules/forms/definition.ts` (`wr_`, `mc_`, `sc_` prefixed fields). No `EventTemplate` model. |

## The event-specific coupling problem

The specification asks that Women's Retreat, Camp Meeting, and club logic not be
hard-coded. Measured: **70 event-specific references across 20 source files**,
including:

- `modules/forms/definition.ts` — WR, Camp Meeting, and club form templates
  defined in code
- `modules/reporting/retreat-packets.ts` and `retreat-packets-repository.ts`
- `modules/attendee-accounts/retreat-hub-repository.ts`
- `modules/communications/shirt-size-audience.ts`
- `modules/imports/wr26-bundle.ts` (legitimately event-specific — a migration)

#104 covers this as "generalize retreat-specific naming." The audit says the
scope is larger than naming: it is **turning hard-coded templates into
`EventTemplate` data**, which is specification §27 and has no issue.

## Missing domains against the specification's minimum data model

Present: users, organizations, events, registration forms, registrations,
households, attendees, attendee answers, promo codes, waitlist entries,
check-ins, transfers, communications, import batches, audit events, payments,
refunds.

Absent, with owning issue where one exists:

| Domain | Issue |
| --- | --- |
| Charges, payment allocations, discounts as entries | #117, #118, #120 |
| Products, orders, order items | #54 |
| Lodging buildings, rooms, beds/sites, reservations, assignments | #64 |
| Meals, meal selections | #81 |
| Sessions with schedule, seminar preferences as records, assignments | #100 |
| Documents and waivers | #129–#132 |
| **Event templates** | **none — filed by this audit** |
| **Notes** | **none — filed by this audit** |
| **Tags** | **none — filed by this audit** |
| **Attendee types as configuration** | **none — filed by this audit** |

`attendeeType` is currently a bare `String` on `RegistrationAttendee`. #100 and
#102 both specify restrictions "by attendee type" as though a configurable
entity exists. It does not.

## Completion against the specification's own standard

The specification defines completeness as thirteen things staff can do without
touching the database or a spreadsheet.

| # | Capability | State |
| --- | --- | --- |
| 1 | Build and publish an event | Partial — no draft/closed/archived, no clone |
| 2 | Individual, household, and group registration | Partial — group is #73/#67 |
| 3 | Calculate complex pricing | **Partial — the weakest link** |
| 4 | Collect and reconcile payments | Collect yes; reconcile is #123 |
| 5 | Sessions, meals, merchandise, lodging | Absent — four issues |
| 6 | Waitlists, changes, transfers, cancellations, refunds | Partial — transfers strong, refund policy is #101 |
| 7 | Targeted communication | Partial — segmentation is #77 |
| 8 | On-site check-in | Built |
| 9 | Operational reports | Partial — limited by missing domains |
| 10 | Import and preserve legacy history | Built for WR26 |
| 11 | Close and reconcile the event | Absent — #72 and #123 |
| 12 | Clone for next year | Absent — #72 |
| 13 | Trustworthy audit trail | Built, except financial history |

## The one principle the platform currently violates

"Nothing important should exist only as the current value."

The platform honours this well for registrations (operation snapshots),
communications (outbox and attempts), promo codes (redemptions preserved),
check-ins, and imports (source values retained).

It violates it in exactly one place, and it is the most consequential one:
**`Registration.totalAmount` is a mutable column** that amendment repricing
overwrites, with balance computed as `totalAmount - paidCents`. How a balance
was reached is not fully recoverable from the database. That single fact is why
the ledger slices (#117–#121) are the highest-priority work on the roadmap.
