# Production readiness review

Reviewed July 24, 2026, against commit `0c44a4f` on `main`. This document reviews the staged
build plan **and** the shipped feature set from one angle only: *what has to be true before this
system holds real attendee, medical, and payment data for a real IMSDA event.*

It is a companion to — not a replacement for — [`BUILD-PLAN-GAP-ANALYSIS.md`](BUILD-PLAN-GAP-ANALYSIS.md)
(which measures the code against the plan's phases) and
[`BUILD-STATUS-AND-WR26-GAP-AUDIT.md`](BUILD-STATUS-AND-WR26-GAP-AUDIT.md) (which measures it
against WR26 behaviors). Those ask "how much is built?" This one asks "can it go live?"

---

## Verdict

**The feature work is real; the operational envelope around it is not.**

The domain code is genuinely production-grade in the places that are hardest to retrofit:
serializable capacity reservations, immutable form versions and answer snapshots, hash-only
session/reset/manage-link storage, signed and deduplicated payment webhooks, idempotent
check-in with a database invariant, transactional outbox with backoff, and a 402-test suite that
actually covers the permission matrix. That is not demo scaffolding — it is the expensive part,
and it is done well.

What does not exist is everything *around* the application: a way to create a real staff account,
a way for a real person to recover a password, backups, monitoring, and a boot-time contract that
fails loudly when misconfigured. The plan put all of that in "Phase 9 — hardening & cutover" and
Phase 9 was never started. That sequencing is the single root cause of the "works but nothing
real" feeling, and it is the thing to fix first.

**Recommended re-sequencing: stop adding feature breadth. Insert a production foundation phase
before any remaining Phase 6/7/8 work.** Details in [Recommended sequence](#recommended-sequence).

---

## P0 — Blocking. The system cannot be stood up for real as it is.

### 1. There is no path from a fresh deploy to a real administrator account

This is the issue behind "the demo setup with passwords is not great," and it is worse than a
weak password — it is a closed loop with no legitimate exit.

Trace the cold start of a brand-new production instance:

1. `docker compose up` applies migrations to an **empty database with zero users**. Nobody can
   sign in. There is no first-run setup screen and no CLI to create an account.
2. The only documented way in is `RUN_DB_SEED=true`
   ([`docs/DEPLOY-DOCKER.md`](DEPLOY-DOCKER.md) first-deploy checklist), which runs
   `prisma/seed.ts`. That seed has no environment guard — unlike
   `scripts/refresh-local-demo.ts:24`, which refuses to run against a non-local hostname — so it
   will happily write to the production database.
3. The seed creates every account with one shared, hardcoded password
   (`prisma/seed.ts:19`, `IMSDA-Local-2026!`) that is **published in the public README**
   (`README.md:51-58`). It also injects fictitious operational data into that same production
   database: 3 events, 5 people, 3 registrations, 2 payments, a refund, promo codes, a household,
   an announcement, and an import run.
4. The only `SYSTEM_ADMIN` in existence is the seeded `system@imsda-events.test`
   (`prisma/seed.ts:41-49`). `globalRole` is settable **only** by the seed — no UI, no API, no
   script promotes a real user. And `SYSTEM_ADMIN` is required to create an event at all
   (`app/event-setup/page.tsx:12`, `modules/events/authorization.ts:9`).
5. So the fictitious admin account cannot be deleted. It is load-bearing.

Now trace onboarding a real colleague. `addStaffMembership` creates their user with a
**random throwaway password hash** (`modules/access/membership-repository.ts:80`) — correct, since
staff shouldn't be handed a password. They are meant to use "forgot password." But:

- `POST /api/auth/password-reset/request` returns the reset link **only when
  `NODE_ENV !== "production"`** (`app/api/auth/password-reset/request/route.ts:43-44`).
- No email is sent. The reset path is not wired to the outbox or to Resend at all.
- The forgot-password page tells the user so, in production, in as many words: *"In this local
  build, the test link appears here instead of being emailed"* (`app/forgot-password/page.tsx:9`).

**Net effect: in production, a newly invited staff member can never obtain a working credential,
and the only usable login is a shared password printed in a public repository.** Every
authorization check, audit log, and role separation in the codebase is downstream of an identity
layer that currently has one shared key.

**Remediation** (roughly in build order):

- **Split bootstrap from demo data.** Keep `prisma/seed.ts` as fictitious demo data and give it a
  hard non-production guard modeled on `scripts/refresh-local-demo.ts:24`. Add a separate
  `scripts/create-admin.ts` (`npm run admin:create`) that takes an email + display name,
  creates the user with `globalRole = SYSTEM_ADMIN`, and prints a one-time activation URL to the
  container log. That is the supported cold-start path; `RUN_DB_SEED` then never belongs in a
  production env panel.
- **Wire password reset and staff invitation to the existing outbox.** The template/outbox/Resend
  machinery already exists and is good — reset and invitation are two more versioned templates.
  This closes the loop for everyone who is not the bootstrap admin.
- **Add an account-activation state.** A user created by `addStaffMembership` should be explicitly
  `PENDING_ACTIVATION` rather than holding a random hash that looks like a real credential. Today
  a disabled-but-unactivated account and an active one are indistinguishable in the schema.
- **Promote/demote `SYSTEM_ADMIN` from the UI**, gated to system admins, so the bootstrap account
  can be retired after a real one exists.
- **Add MFA (TOTP) for `SYSTEM_ADMIN` and `EVENT_ADMIN`** before real financial and medical data
  lands. Not optional for accounts that can export a full attendee roster.
- **Enforce a password policy worth the name.** `modules/access/passwords.ts:11-17` blocks a
  hardcoded list of five strings. Twelve characters plus a five-entry denylist is a demo policy.
  Either integrate a real breached-password check or raise the length floor substantially.

The scrypt parameters (N=131072), the salted hash format, the timing-safe compare, the dummy-work
`spendPasswordCheck` for non-existent accounts, and the lockout after 5 attempts are all correct.
The primitives are fine. It is the **account lifecycle** that is missing.

### 2. A single bad environment variable silently 403s every write in the system

`isSameOriginRequest` (`modules/access/request-security.ts:13`) now calls `getServerEnv()` inside a
`try` whose `catch` returns `false`. `getServerEnv()` throws on *any* env validation failure —
including a malformed `DATABASE_URL` or an `APP_BASE_URL` that is not a valid URL
(`lib/env.ts:22-24`).

So a single typo in the env panel does not produce a startup crash or a 500. It produces
`403 INVALID_REQUEST_ORIGIN — "This request must come from the IMSDA Events workspace."` on
**every mutation route in the application**: public registration submission, payment, check-in,
staff edits, everything. Reads keep working, so the app looks alive. The error message points the
operator at CORS and proxy configuration, which is the wrong place entirely.

This is currently observable: run `npx vitest run` without `DATABASE_URL` in the environment and
30 tests fail, all of them `expected 403`. Export a valid `DATABASE_URL` and all 402 pass. CI
happens to set it, which is why it is green.

**Remediation:** validate the whole environment once at startup and refuse to boot on failure
(see P1 #1). Separately, `isSameOriginRequest` should let a configuration error propagate as a 500
rather than degrade into a misleading 403 — a config fault and a cross-origin request are not the
same event and must not share a response.

### 3. No backups, and no evidence a restore works

Once the production database is authoritative for registrations and payments, an unbackedup
Postgres volume is the largest single risk in the deployment. There is no `pg_dump` schedule, no
retention policy, no off-host copy, and no restore rehearsal. The compose file keeps the data in a
named volume (`imsda_events_postgres`) on one host.

**Remediation:** nightly `pg_dump` to off-host storage, documented retention, and — the part that
is usually skipped — a scheduled restore into a scratch database that verifies row counts. A backup
that has never been restored is not a backup. Do this before the first real registration, not
before the first real event.

---

## P1 — Required before real attendee data, not necessarily before first login.

### 1. Environment validation is partial and lazy

`lib/env.ts:3-7` validates exactly three variables: `DATABASE_URL`, `APP_BASE_URL`, `NODE_ENV`.
Every security-critical secret is validated somewhere else, lazily, at first use, deep inside a
request:

| Secret | Validated at | Failure surfaces as |
| --- | --- | --- |
| `MANAGE_LINK_DERIVATION_SECRET` | `modules/public-access/repository.ts:139` | Registration succeeds, confirmation link generation throws |
| `ATTENDEE_PASS_SIGNING_SECRET` | `modules/checkin/attendee-pass-token.ts:61` | Discovered when a QR pass is first requested — possibly at the event |
| `RATE_LIMIT_HASH_SECRET` | `modules/rate-limit/domain.ts:54` | First rate-limited endpoint call |

Each individual check is well written (32-char minimum, production-only enforcement, rotation
support via `_PREVIOUS`). The problem is *when* they run. A deployment missing
`ATTENDEE_PASS_SIGNING_SECRET` boots cleanly, serves pages, accepts registrations, and fails on
check-in morning.

**Remediation:** one schema covering every variable the app can read, evaluated at startup, with
the process refusing to start in production if it fails. Keep the per-module checks as belt and
braces.

### 2. Email retries are stranded without a sweeper

The outbox has proper exponential backoff (`modules/communications/email-delivery.ts:26-27`, 1 min
→ 60 min, 5 attempts) and a 10-minute lock timeout for crashed workers. Messages are delivered
inline after commit via `processQueuedMessageIdsAfterCommit`, which covers the happy path.

But a message that fails and gets rescheduled is only picked up by
`POST /api/events/:eventId/messages/process`, whose sole caller in the entire codebase is a button
in the staff UI (`components/communications-workspace.tsx:447`). Nothing sweeps the queue on a
timer. Likewise, a message stranded by a container restart mid-delivery stays stranded until
someone happens to open Communications and click.

**Remediation:** a scheduled sweep — a small container-side cron hitting an authenticated internal
endpoint is sufficient at this scale, no queue infrastructure needed. Pair it with an alert when
outbox depth or oldest-pending-age crosses a threshold.

### 3. No error monitoring, and logs are unstructured

56 `console.*` calls across `app/`, `modules/`, `integrations/`, and `lib/`. They go to stdout, are
plain strings, carry no correlation ID, and nothing aggregates or alerts on them. Nobody will
notice a spike in failed payment webhooks or check-in errors.

The auth routes are careful — they log `error.name` only (`app/api/auth/login/route.ts:73`) —
but this is inconsistent: `app/api/auth/password-reset/complete/route.ts:31` logs the full error
object, which can carry a Prisma query with parameters.

**Remediation:** structured JSON logging with a per-request correlation ID and an explicit redaction
list; an error-tracking service; alerts on the health endpoint, outbox depth, webhook failure rate,
and 5xx rate. Audit `AuditLog` already carries a `correlationId` — extend the same ID through
request logging so an operator can follow one registration end to end.

### 4. Medical, dietary, and screening answers are stored in plaintext JSON

The plan calls for field-level encryption for medical/insurance/screening data. Answers are
currently stored as JSON snapshots with no encryption at rest beyond whatever the volume provides
(which, in the current compose file, is none). For a conference collecting minors' medical
information, this is a policy question as much as a technical one.

**Remediation:** decide the standard now, because retrofitting encryption across immutable answer
snapshots gets harder with every registration. At minimum: disk encryption on the host, restricted
database access, and a documented retention/deletion procedure. Field-level encryption for the
specific medical/screening field keys is the stronger answer.

### 5. Session model has no idle timeout and no user-facing revocation

Sessions are fixed 8-hour, non-sliding, non-rotating (`modules/access/session-store.ts:11`). There
is no idle expiry, no rotation on privilege change, and no "sign out everywhere" in the UI —
`revokeAllUserSessions` exists but is only called by the password reset path. `userAgentHash` is
recorded but never checked. For staff using shared check-in tablets at an event, an 8-hour session
with no idle timeout is a long window.

**Remediation:** idle timeout in addition to absolute expiry; session rotation on role change; a
sessions list with revocation in account settings.

---

## P2 — Correctness and hygiene issues found during review.

- **`docs/DEPLOY-DOCKER.md` documents an `APP_PORT` variable that does not exist.** The compose
  file hardcodes `ports: "3100:3000"`. An operator following the doc to resolve a port collision
  will set `APP_PORT` and see no effect. Either wire `${APP_PORT:-3100}:3000` into
  `docker-compose.yml` or correct the doc.
- **`POSTGRES_PASSWORD` is required by `docker-compose.yml` but the deploy doc lists it as
  optional** ("overrides the default dev password" — there is no default anymore since `5324a4d`).
  Deploying without it fails at Postgres startup. Move it to the required block.
- **`IMSDA_DEMO_SESSION: enabled` in `.github/workflows/ci.yml` is dead.** No code reads it. It is
  a leftover from an earlier demo-session bypass; leaving an env var named "demo session" in CI
  invites someone to reintroduce the bypass it implies. Remove it.
- **The vitest suite has an undeclared dependency on `DATABASE_URL`.** Set it in
  `vitest.config.ts` so a clean checkout passes `npm test` without a preconfigured shell. Right now
  a new contributor's first test run shows 30 failures for reasons unrelated to their change.
- **No `/api/health` coverage for the outbox or external adapters.** The check verifies the app and
  a `SELECT 1` (`app/api/health/route.ts`). It reports healthy while email delivery is completely
  broken. Add queue depth and adapter reachability as a separate readiness signal.
- **No documented staging environment.** Square production activation, webhook URL verification,
  and cutover rehearsal all assume somewhere to rehearse. There is one compose file.

---

## Review of the build plan itself

The plan's phase ordering is sound for building a *product*, and wrong for shipping a *service*.
Phases 0–8 deliver capability; Phase 9 delivers the ability to operate any of it. Because Phase 9
was scheduled last and the team built ahead of schedule through Phases 4 and 5, the result is a
system with sophisticated features that cannot be legitimately turned on. The gap analysis
correctly reports Phase 9 as "not started" but presents it as one item among seven; in practice it
gates all of the others.

Two more observations on the plan:

**The financial ledger decision cannot stay open much longer.** Plan §4.4 explicitly warns against
a single payment status on the registration and asks for `Order`/`OrderItem`, `Discount`,
`PriceAdjustment`, and an append-only balance. The implementation derives balance from pricing
snapshots plus promo redemptions. The derived model has held up well through promo codes, partial
refunds, waitlist promotion, and card-fee gross-up — that is real evidence it can work. But every
real payment recorded against it raises the migration cost, and reconciliation against Square in an
audit is materially easier with an append-only ledger. **Decide before Square production is
unlocked, not after.**

**Phase 3's live WR26 adapter should be formally cut.** CSV-upload staging is built, tested, and
idempotent, with source snapshots and an exception report. A live Google Apps Script reader would
add a fragile dependency on the architecture the plan explicitly says not to copy. Recommend
closing it as "won't build" and documenting CSV as the supported path, rather than leaving it as
open backlog.

**What the plan gets right and should be preserved:** the guardrail that external integrations
never block a core registration transaction; server-authoritative pricing recomputation; immutable
form versions; and the Square production lock behind a separate explicit unlock
(`integrations/square/client.ts:38`). These are the decisions that make the codebase trustworthy,
and none of them should be relaxed to move faster on the items above.

---

## Recommended sequence

Feature breadth (attendee app, communications targeting, additional adapters, remaining printable
reports) should pause until the first two blocks below are done.

| Order | Work | Done when |
| --- | --- | --- |
| 1 | Admin bootstrap script; seed guarded to non-production; `SYSTEM_ADMIN` promotion in UI | A fresh deploy reaches a working real admin account with zero fictitious rows in the database |
| 2 | Password reset + staff invitation email through the existing outbox; account activation state | An invited colleague activates and signs in without an operator touching the database |
| 3 | Startup env validation for every variable; config errors surface as 500, not 403 | A missing `ATTENDEE_PASS_SIGNING_SECRET` fails the deploy, not check-in morning |
| 4 | Backups, off-host retention, verified restore | A restore rehearsal has been completed and its row counts recorded |
| 5 | Structured logs with correlation IDs and redaction; error tracking; alerts | A failed payment webhook pages someone |
| 6 | Scheduled outbox sweep; health check covers queue depth | A message that fails its first attempt is delivered with no staff action |
| 7 | MFA for admin roles; real password policy; session idle timeout and revocation | An admin account cannot be taken over by a single leaked password |
| 8 | Medical-data encryption decision; retention/deletion/export procedure | The standard is documented and implemented for the identified field keys |
| 9 | Staging environment; go-live checklist; cutover rehearsal; then the Square production unlock | A rehearsal has run end to end against staging with test-mode money |
| 10 | Printable passes and rosters (the current event-day release gate), then resume Phase 6/7/8 breadth | — |

Items 1–3 are days of work, not weeks, and they convert the system from a convincing demo into
something that can hold a real registration. Items 4–6 are what make it safe to leave running.

---

## Verification performed for this review

Against commit `0c44a4f`, in this workspace:

```
npm ci                                                    ✅
npx vitest run                                            ❌ 30 failed / 402 (no DATABASE_URL)
DATABASE_URL=postgresql://... npx vitest run              ✅ 402 passed (84 files)
```

Static review of: deployment (`Dockerfile`, both compose files, `docker-entrypoint.sh`,
`docs/DEPLOY-DOCKER.md`), identity (`modules/access/*`, all four auth routes, `prisma/seed.ts`),
configuration (`lib/env.ts`, `next.config.ts`, `.env.example`), delivery
(`modules/communications/email-delivery.ts`, `messaging-repository.ts`), and all 56 route handlers
by inventory. No database-backed integration scripts (`npm run test:public-*`) were run — they
require a live PostgreSQL instance and a running dev server.
