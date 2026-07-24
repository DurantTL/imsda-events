# Production readiness progress

Tracks implementation against the ten-step sequence in
[`PRODUCTION-READINESS-REVIEW.md`](PRODUCTION-READINESS-REVIEW.md). The review says what
has to be true before this system holds real attendee, medical, and payment data. This
document says how far along that is, and is updated as work lands.

**Status: items 1, 3, 4 and 6 are done; item 2 is partly done; items 5 and 7–10 are not
started.** All three P0 blocking findings are addressed. What remains before real data is
principally observability (item 5), MFA and session hardening (item 7), and the
medical-data encryption decision (item 8).

---

## Sequence status

| # | Work | Status |
| --- | --- | --- |
| 1 | Admin bootstrap script; seed guarded to non-production; `SYSTEM_ADMIN` promotion in UI | **Done** |
| 2 | Password reset + staff invitation email through the outbox; account activation state | **Partly done** — activation state and one-time links ship; email delivery does not |
| 3 | Startup env validation for every variable; config errors surface as 500, not 403 | **Done** |
| 4 | Backups, off-host retention, verified restore | **Done**, with one operator decision outstanding |
| 5 | Structured logs with correlation IDs and redaction; error tracking; alerts | Not started |
| 6 | Scheduled outbox sweep; health check covers queue depth | **Done** |
| 7 | MFA for admin roles; real password policy; session idle timeout and revocation | Not started |
| 8 | Medical-data encryption decision; retention/deletion/export procedure | Not started |
| 9 | Staging environment; go-live checklist; cutover rehearsal; Square production unlock | Not started |
| 10 | Printable passes and rosters, then resume Phase 6/7/8 breadth | Not started |

---

## 1. Admin bootstrap — done

**Done when:** a fresh deploy reaches a working real admin account with zero fictitious
rows in the database. It does.

- `npm run admin:create -- --email <address> --name "<name>"`
  (`scripts/create-admin.ts`) creates or promotes a `SYSTEM_ADMIN` and prints a one-time
  activation URL. It writes one user, one credential, one token, and one audit entry —
  no events, people, registrations, or payments.
- `prisma/seed.ts` now refuses to run with `NODE_ENV=production` or against any
  non-loopback database host, modelled on `scripts/refresh-local-demo.ts`.
- `RUN_DB_SEED` is gone from `docker-compose.yml`. `docker-entrypoint.sh` exits with an
  explanation if it is still set, rather than silently ignoring it.
- `PATCH /api/users/:userId/global-role` grants and removes `SYSTEM_ADMIN`, gated to
  system administrators, surfaced in **Staff access**. It refuses to remove the last one
  and revokes the target's sessions, since a privilege change must not be carried by a
  session that predates it. The bootstrap account can now be retired.
- The sign-in page no longer prefills or displays the shared demo password in
  production, and the forgot-password form no longer defaults to the seeded address.

## 2. Account lifecycle — partly done

**Done when:** an invited colleague activates and signs in without an operator touching
the database. **They can — but the link still has to be handed over by a person.**

Shipped:

- `UserAccountStatus` (`PENDING_ACTIVATION` / `ACTIVE`) and `activatedAt` on `User`;
  `AccountTokenPurpose` on `PasswordResetToken`
  (`prisma/migrations/20260724000000_account_activation`).
- `addStaffMembership` creates the account `PENDING_ACTIVATION`. Its random hash is
  still unguessable, but the schema now says so instead of leaving a pending account
  indistinguishable from a live one. `authenticateWithPassword` refuses a pending
  account outright.
- Activation and reset are one hash-only token with different lifetimes — seven days
  and thirty minutes. Choosing a password is what activates the account, done inside the
  same transaction so the two cannot drift.
- The invite flow returns a working activation link **in production too**, shown once to
  the administrator who created the account. Previously the link was suppressed outside
  development, which is what made an invited colleague unable to obtain a credential at
  all.

Not shipped — **email delivery for activation and reset**:

`MessageOutbox.eventId` is non-null and `processExternalEmailQueue` is event-scoped,
taking its sender identity from `EventMessageSettings`. Account email belongs to no
event, so routing it through the existing outbox means making `eventId` nullable,
generalising the worker, and adding global sender configuration. That is a real change
to the delivery path that carries the registration confirmations, and it was not worth
bundling into this branch. Until it lands, the forgot-password page says plainly that
recovery email is not connected rather than promising a link it never shows.

Also not started: MFA and the password policy (both sit under item 7).

## 3. Startup environment contract — done

**Done when:** a missing `ATTENDEE_PASS_SIGNING_SECRET` fails the deploy, not check-in
morning. It does.

- `lib/env.ts` describes every variable the app reads. The security-critical secrets are
  required in production instead of being validated lazily at first use, inside a
  request, deep in a module.
- `instrumentation.ts` validates once at startup and refuses to boot production on
  failure, naming the offending variable. Outside production it warns, so local work is
  not blocked by an unset Square key. Build is skipped — a build has no deployment
  environment to check.
- `isSameOriginRequest` no longer swallows configuration faults. A malformed
  `DATABASE_URL` or `APP_BASE_URL` used to return `403 INVALID_REQUEST_ORIGIN` on every
  mutation route while reads kept working, pointing the operator at CORS. It is now a
  `500 SERVER_MISCONFIGURED`.
- The per-module checks in `rate-limit/domain.ts`, `checkin/attendee-pass-token.ts`, and
  `public-access/repository.ts` are untouched, as belt and braces.
- `vitest.config.ts` declares `DATABASE_URL`, so a clean checkout passes `npm test`
  without a preconfigured shell. This was the review's observable symptom: 30 tests
  failing with `expected 403` for reasons unrelated to the change under test.

## 4. Backups and verified restore — done, one decision outstanding

**Done when:** a restore rehearsal has been completed and its row counts recorded. The
machinery exists and has been exercised end to end.

- `scripts/backup/pg-backup.sh` — nightly `pg_dump -Fc`, written to a temporary name
  first so a crash cannot leave a truncated file that looks usable, with a size floor and
  `BACKUP_RETENTION_DAYS` pruning.
- `scripts/backup/pg-restore-verify.sh` — restores the newest dump into a scratch
  database with `--exit-on-error`, prints every non-empty table's row count, and asserts
  counts for `Registration`, `RegistrationAttendee`, `Payment`, and `Person`. A restore
  that returns an empty `Registration` table has failed however clean the exit code was.
  It refuses to run if the scratch name matches the live database.
- `scripts/backup/backup-scheduler.sh` and the `backup` service in `docker-compose.yml`
  run the backup nightly and the rehearsal every `BACKUP_VERIFY_EVERY` runs. A failed
  rehearsal is loud but does not stop future backups.

Verified during development against PostgreSQL 16: a dump of the seeded database restored
into a scratch database reporting `Registration=3`, `RegistrationAttendee=5`,
`Payment=2`, `Person=5`.

**Outstanding, and it is an operator decision, not a code change:** the dumps currently
land in a Docker volume on the same host as the database. Bind `imsda_events_backups` to
off-host storage or set `BACKUP_OFFSITE_COMMAND`. A dump that shares a host with its
source does not survive losing that host.

## 5. Structured logging and alerting — not started

56 `console.*` calls still go to stdout as plain strings with no correlation ID and
nothing aggregating them. Two things were fixed opportunistically —
`app/api/health/route.ts` and the new routes log `error.name` rather than a full error
object, matching the careful pattern in the auth routes — but
`app/api/auth/password-reset/complete/route.ts:31` still logs a whole error object that
can carry a Prisma query with parameters, and there is no error tracking or alerting.

## 6. Outbox sweep and health readiness — done

**Done when:** a message that fails its first attempt is delivered with no staff action.
It is.

- `modules/communications/outbox-sweep.ts` finds every event holding a due message and
  runs the existing per-event processor. One event's misconfiguration is recorded and the
  sweep continues rather than stopping the others. Unattended runs record no audit actor
  instead of attributing the work to a fabricated account.
- `POST /api/internal/outbox/sweep` is a machine endpoint: bearer token compared in
  constant time, no session, no same-origin check (that check exists to protect
  cookie-authenticated routes from a browser). It is always 401 when
  `OUTBOX_SWEEP_TOKEN` is unset — never open by omission — and the token is required in
  production by the startup contract.
- The `outbox-sweeper` service in `docker-compose.yml` calls it every
  `OUTBOX_SWEEP_INTERVAL_SECONDS` (default 300).
- `/api/health` now reports outbox depth, due count, oldest-due age, and processing and
  failed counts, and goes `degraded` past 25 due messages or 30 minutes of waiting. It
  previously reported healthy while email delivery was completely broken. A backed-up
  queue stays HTTP 200 deliberately — only a database failure returns 503, so a queue
  problem does not make the orchestrator restart a container that is still serving
  registrations.

Alerting on these signals is part of item 5 and is not done.

## 7. MFA, password policy, session hardening — not started

Sessions are still fixed 8-hour, non-sliding, non-rotating, with no idle timeout and no
user-facing revocation. `modules/access/passwords.ts` still enforces twelve characters
against a five-entry denylist. There is no MFA.

One piece of this landed as a side effect: `setGlobalRole` revokes the target's sessions,
so a privilege change is not carried by an older session.

## 8. Medical-data encryption — not started

Answers remain plaintext JSON snapshots. This needs a policy decision before code, and
the review is right that it gets harder with every registration recorded.

## 9. Staging environment — not started

There is still one compose file. Square production remains locked behind
`SQUARE_ENVIRONMENT=production` **and** `SQUARE_ENABLE_PRODUCTION=true`, and the startup
contract now enforces that pairing — setting the environment to production without the
unlock fails the deploy rather than being silently ignored.

## 10. Printable passes and rosters — not started

Unchanged; still the event-day release gate.

---

## Verification

Against a local PostgreSQL 16 with all migrations applied:

```
npx prisma migrate deploy                    ✅ 25 migrations, no drift on changed models
npm run lint                                 ✅
npm run typecheck                            ✅
npx vitest run                               ✅ 453 passed (90 files), 51 new
npx vitest run  (with no DATABASE_URL set)   ✅ 453 passed — was 30 failures before
npm run admin:create                         ✅ created and promoted; both guards exercised
npx prisma db seed  (NODE_ENV=production)    ✅ refused
npx prisma db seed  (remote host)            ✅ refused
scripts/backup/pg-backup.sh                  ✅ 159 KB dump written and pruned
scripts/backup/pg-restore-verify.sh          ✅ rehearsal passed with row counts
npm run build                                ✅
```

Exercised against a running production build:

- Production start with a secret missing → **refused**, naming all four variables.
- Production start with secrets set → ready; `/api/health` `ok` with the outbox reported.
- `POST /api/internal/outbox/sweep` → 401 with no token, 401 with a wrong token, 200 with
  the right one.
- Cross-origin write → 403; same-origin write with bad credentials → 401.
- Malformed `APP_BASE_URL` → **500 `SERVER_MISCONFIGURED`**, the review's exact symptom,
  which previously returned 403 `INVALID_REQUEST_ORIGIN` on every mutation route.
- Production `/login` contains no occurrence of the shared demo password.

The database-backed `npm run test:public-*` scripts were not run; they need a running dev
server as well as a database.
