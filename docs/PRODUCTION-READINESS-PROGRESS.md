# Production readiness progress

Tracks implementation against the ten-step sequence in
[`PRODUCTION-READINESS-REVIEW.md`](PRODUCTION-READINESS-REVIEW.md). The review says what
has to be true before this system holds real attendee, medical, and payment data. This
document says how far along that is, and is updated as work lands.

**Status: items 1–7 and 10 are done.** All three P0 blocking findings are
addressed, and every P1 and P2 finding with code behind it has landed. The
medical-data encryption decision (item 8) remains a platform backlog item but
has been explicitly removed from the Women’s Retreat release gate. The
deployment/configuration rehearsal and Square Sandbox test in item 9 remain the
release work that cannot be proven by the repository alone.

---

## Sequence status

| # | Work | Status |
| --- | --- | --- |
| 1 | Admin bootstrap script; seed guarded to non-production; `SYSTEM_ADMIN` promotion in UI | **Done** |
| 2 | Password reset + staff invitation email through the outbox; account activation state | **Done** |
| 3 | Startup env validation for every variable; config errors surface as 500, not 403 | **Done** |
| 4 | Backups, off-host retention, verified restore | **Done**, with one operator decision outstanding |
| 5 | Structured logs with correlation IDs and redaction; error tracking; alerts | **Done** |
| 6 | Scheduled outbox sweep; health check covers queue depth | **Done** |
| 7 | MFA for admin roles; real password policy; session idle timeout and revocation | **Done** |
| 8 | Medical-data encryption decision; retention/deletion/export procedure | Deferred beyond the Women’s Retreat release; platform backlog |
| 9 | Staging environment; go-live checklist; cutover rehearsal; Square production unlock | In progress on the deployed sandbox environment |
| 10 | Printable passes and rosters, then resume Phase 6/7/8 breadth | **Done** |

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

## 2. Account lifecycle — done

**Done when:** an invited colleague activates and signs in without an operator touching
the database. They can, and the link now reaches them by email.

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

Also shipped — **email delivery for activation and reset**:

`MessageOutbox.eventId` was non-null and `processExternalEmailQueue` was event-scoped,
taking its sender identity from `EventMessageSettings`. Account email belongs to no
event, so it had nowhere to go. That is now fixed rather than worked around:

- `eventId` is nullable (`prisma/migrations/20260724120000_account_email_delivery`), and
  the delivery worker is **scoped** rather than event-bound. Claiming, backoff, attempt
  history, stale-lock recovery, and provider events are identical for both slices;
  `processAccountEmailQueue` is the account entry point, governed by
  `ACCOUNT_EMAIL_SENDER_ADDRESS` instead of a per-event setting.
- The scheduled sweep processes the null-event group alongside every event, so an account
  email that fails its first attempt is retried with no staff action.
- **The queued row stores a sentinel, never a token.** The one-time link is minted at
  delivery — the same thing `prepareEmailBodyForDelivery` already does for private
  registration links — so a database read yields nothing usable, and a reset link's
  thirty minutes start when it is sent rather than when it is queued. An attempt that
  fails definitively retires the token it minted.
- `RESEND_API_KEY` and `ACCOUNT_EMAIL_SENDER_ADDRESS` are now required in production by
  the startup contract. Account recovery is the one email path with no manual
  alternative, so a deployment that cannot send it is one where an invited colleague can
  never obtain a credential.
- Where they are unset — development only — the previous behaviour stands: the link is
  shown on the page, or returned to the inviting administrator. Both surfaces say which
  of the two is happening.

Account template keys are kept out of the event Communications page by two guards at the
query boundary, so the record types the UI reads stay narrow.

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

## 5. Structured logging and alerting — done

Shipped — **structured logging with an explicit redaction rule**:

- `lib/logger.ts` emits one JSON object per event with a level, timestamp, message, and
  arbitrary context fields.
- Redaction is **deny-by-default**. An error contributes its class name and a short code;
  its `message` is included only for the application's own error classes, whose text is
  authored for an operator. This is the fix for the review's specific finding: a Prisma
  error's `message` embeds the failing query **and its parameters**, so
  `console.error("...", error)` could put attendee data — including medical answers — into
  the container log. `ZodError` is excluded for the same reason, since its issues can echo
  the submitted value.
- All 61 `console.*` call sites across `app/`, `modules/`, `integrations/` and `lib/` now
  go through the logger. There are none left in application code.
- `onRequestError` in `instrumentation.ts` catches every server error Next.js sees,
  including ones no handler caught, and records the route path, method, route type, and
  any inbound correlation ID.
- `requestCorrelationId` reuses a proxy-supplied `x-correlation-id` so one registration
  can be followed end to end, and mints a UUID otherwise. The inbound value is length- and
  character-bounded, because it is attacker-controlled and lands in a log line.

Verified: with an unreachable database, `/api/health` logged exactly
`{"level":"error",...,"error":{"name":"PrismaClientInitializationError","redacted":true}}`
and the connection string's password appeared nowhere in the output.

Also shipped — **request-scoped correlation IDs**:

- `lib/request-context.ts` holds one ID per request in an `AsyncLocalStorage` store, and
  the logger reads it through an injected accessor rather than importing the store — a
  cycle between the logger and the request context would resolve differently in each
  runtime. Every line written anywhere inside a request now carries `correlationId`,
  `method`, and `path` without a single signature changing, which was the alternative.
- `withRequestContext` wraps all 60 API route handlers. It reuses an inbound
  `x-correlation-id` when a proxy supplied one — bounded and character-checked, because it
  is attacker-controlled — and sets the header on the response, so someone reporting a
  failed registration can quote a value that appears in the logs.
- `writeAuditLog` defaults `correlationId` to the request's own, so an audit entry, the
  log lines around it, and the response header all carry one value.

Also shipped — **alerting**:

- `modules/operations/alerting.ts` dispatches to `ALERT_WEBHOOK_URL` (a Slack or Teams
  incoming webhook, or anything accepting a JSON POST) and logs every alert at its
  severity, so a deployment without a webhook still leaves a trail to match on.
- Suppression is the part that decides whether alerting survives contact with an
  operator: `AlertNotification` holds one row per **condition**, so a persistent problem
  pages once per `ALERT_REPEAT_MINUTES` (60 by default) rather than every five minutes. A
  condition that stops being true is cleared, so a recurrence pages at once. A page that
  failed to deliver is deliberately not recorded — a dropped page must not mute the hour.
- `modules/operations/alert-scan.ts` reads the system-wide signals and raises: queue
  backed up, a message that gave up after all five attempts, a failed card payment, and a
  card payment that never reached a result after fifteen minutes — **which is what a
  missing Square webhook looks like from the inside**. It runs at the end of the outbox
  sweep, which already runs every few minutes: one cron, one credential, and the queue's
  state is known there anyway.
- Raised immediately rather than on the next scan: a Square webhook that fails signature
  verification (urgent — either forged events or a key that no longer matches, in which
  case no payment result is being recorded at all), a Resend webhook that fails
  verification (watch), and a database that cannot be reached, which is dispatched without
  suppression because there is nowhere to record it.

Per-event operational health remains a page someone reads. What is alerted on is the
subset nobody will be looking at when it matters.

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

Alerting on these signals landed with item 5.

## 7. MFA, password policy, session hardening — done

Shipped — **session hardening**:

- A 60-minute idle timeout alongside the 8-hour absolute expiry. `lastSeenAt` was
  recorded but never read; `getCurrentSession` now checks it and rejects an idle session
  even while its absolute expiry is hours away. Walking away from a shared check-in
  tablet no longer leaves a session usable for the rest of the day.
- `lastSeenAt` is advanced at most once a minute, guarded on the observed value so
  concurrent requests do not race, and on `revokedAt` so a session revoked in between is
  not resurrected.
- `GET`/`DELETE /api/auth/sessions` and a **Signed-in devices** panel in **More** list
  the sessions that can currently sign in as the account and sign out the others.
  `revokeAllUserSessions` already existed but was only ever called by the password reset
  path, so nobody could end a session they had left open somewhere.
- Session rotation on privilege change: `setGlobalRole` revokes the target's sessions, so
  a change of privilege is never carried by a session that predates it.
- `getCurrentSession` also rejects a session whose account is not `ACTIVE`, so
  de-activating an account takes effect on the next request.

Also shipped — **MFA for `SYSTEM_ADMIN` and `EVENT_ADMIN`**:

- Enforcement is at sign-in, not in permission checks. A correct password for one of these
  accounts produces a **challenge**, not a session, and an account that has never enrolled
  is sent to enrol inside that same challenge. So no privileged session can exist behind a
  password alone, and no authorization check anywhere else has to know MFA exists.
- `modules/access/totp.ts` is RFC 6238, pure and clock-injected, tested against the
  published appendix B vectors — the only way to know it agrees with the authenticator apps
  rather than with itself. Drift is one step either side. An accepted step is recorded and
  spent, which stops a code being replayed inside its own thirty seconds; the same rule
  refuses an earlier step, so drift cannot be used to rewind.
- A TOTP secret is the one credential here that cannot be a digest, since verifying a code
  needs the secret itself. `lib/secret-box.ts` seals it with AES-256-GCM under a key
  derived per purpose from `SECRET_ENCRYPTION_KEY` through HKDF, with a fresh nonce per
  value, so a dump yields nothing usable and a sealed value cannot be moved between
  columns. `SECRET_ENCRYPTION_KEY` joins the production startup contract.
- Ten single-use recovery codes per enrolment, stored as digests. Five wrong codes locks
  verification for fifteen minutes; a challenge expires in ten minutes, allows five
  attempts, and is single-use. Removing a second factor is refused for an account whose
  role requires one.
- Because enforcement can lock an administrator out, `npm run admin:reset-mfa` clears an
  enrolment from the command line and revokes every session for the account. It requires
  shell access deliberately: whoever has that is already trusted with the database, and the
  next sign-in enrols again anyway.
- `MFA_REQUIRED_EVENT_ROLES` is left at the two roles the review named, even though
  `REGISTRATION_MANAGER` and `FINANCE_MANAGER` also hold `VIEW_REPORTS` and
  `VIEW_SENSITIVE_DATA`. Widening it is one line, and it is IMSDA's call: each role added
  is a role a lost phone can lock out of an event.

Also shipped — **a real password policy**:

- Fourteen characters counted in code points, no composition rules — requiring a digit and
  a symbol is what produces `Password1!`, and NIST has recommended against them since SP
  800-63B.
- Structural rules that see through padding. A password is reduced to the word behind it by
  stripping the padding at either end, then undoing letter substitutions, then keeping the
  letters; each candidate is checked against a denylist of corpus base words, keyboard runs,
  and words specific to this deployment. `P@ssw0rd1234!!`, `Sunshine!!!!!!!!`,
  `letmein-letmein-letmein`, and `imsda-events-2026` are all caught by the entry they are
  built from. Repetition, straight runs, and anything containing the account holder's own
  name or email address are refused.
- A live check against a public breach corpus by the k-anonymity range protocol: only the
  first five hex characters of the password's SHA-1 leave the process. **It fails open** — a
  password set is the last step of every activation and recovery, and refusing to complete
  it because a third-party API is down would lock people out to prevent a weaker password.
  Unset means on in production and off elsewhere.
- `npm run admin:create --password-from-env` sets a bootstrap administrator's password
  directly from `IMSDA_ADMIN_PASSWORD` and activates the account, for a first deploy where
  account email is not configured or no browser can reach the domain. The password is read
  from the environment rather than an argument so it stays out of shell history and `ps`,
  is held to the same policy, and is stored only as its scrypt hash.

## 8. Medical-data encryption — deferred beyond the Women’s Retreat release

Answers remain plaintext JSON snapshots. This needs a policy decision before code, and
the review is right that it gets harder with every registration recorded.

One piece of the groundwork now exists: `lib/secret-box.ts` is authenticated encryption
with per-purpose key derivation, written for TOTP secrets but not specific to them. What
is still missing is the decision — which field keys, whether they stay searchable, and
what the retention and deletion procedure is — not the primitive.

For the Women’s Retreat, Caleb explicitly removed this item from the release
scope on July 30. That is a prioritization decision, not evidence that the
platform-level risk is solved. Existing least-privilege access, redacted logs,
backups, and restricted reports remain required.

## 9. Staging environment — in progress

The replacement deployment is running as a real sandbox/test environment, but
the full cutover evidence has not yet been recorded. Square production remains locked behind
`SQUARE_ENVIRONMENT=production` **and** `SQUARE_ENABLE_PRODUCTION=true`, and the startup
contract now enforces that pairing — setting the environment to production without the
unlock fails the deploy rather than being silently ignored.

## 10. Printable passes and rosters — done

The workspace now has print-specific Avery attendee pass sheets, operational
rosters, and grouped retreat packets. Group packets include contacts, attendee
checklists, shirt/check-in counts, latest applied session assignments, and
structured meal/housing counts. Free-text protected answers are excluded from
the packet builder.

---

## Verification

Current verification against local PostgreSQL with all 45 migrations applied:

```
npx prisma migrate deploy                    ✅ 45 migrations applied
npm run lint                                 ✅
npm run typecheck                            ✅
npx vitest run                               ✅ 904 passed (148 files)
npm run admin:create                         ✅ created and promoted; both guards exercised
npm run admin:create --password-from-env     ✅ ACTIVE with a scrypt hash and no token row
npm run admin:reset-mfa                      ✅ enrolment removed, sessions revoked
npx prisma db seed  (NODE_ENV=production)    ✅ refused
npx prisma db seed  (remote host)            ✅ refused
scripts/backup/pg-backup.sh                  ✅ 159 KB dump written and pruned
scripts/backup/pg-restore-verify.sh          ✅ rehearsal passed with row counts
npm run build                                ✅
```

The identity and alerting paths were exercised against that database directly, since they
are the ones a unit test can only approximate:

- A correct password for a `SYSTEM_ADMIN` returned the **enrol** gate and left **zero**
  live sessions. The stored enrolment contained no plaintext secret. A wrong code issued
  nothing; the real code signed in and returned ten recovery codes. The consumed challenge
  was refused. The next sign-in demanded a code, and the code just used was refused as
  spent. A recovery code signed in once and was refused on reuse.
- A weak `IMSDA_ADMIN_PASSWORD` was refused before any row was written; a good one produced
  an `ACTIVE` account whose right password verified and whose near-miss did not.
- An alert posted to a stub webhook once, was suppressed on the immediate repeat, was
  cleared when the condition stopped being true, and paged again at once on recurrence. Its
  log line carried `alertKey`, `severity`, and the operator-facing detail.

Exercised against a running production build:

- Production start with a secret missing → **refused**, naming every one of them —
  including `SECRET_ENCRYPTION_KEY`, `RESEND_API_KEY`, and `ACCOUNT_EMAIL_SENDER_ADDRESS`.
- Production start with secrets set → ready; `/api/health` `ok` with the outbox reported.
- `POST /api/internal/outbox/sweep` → 401 with no token, 401 with a wrong token, 200 with
  the right one.
- Cross-origin write → 403; same-origin write with bad credentials → 401.
- Malformed `APP_BASE_URL` → **500 `SERVER_MISCONFIGURED`**, the review's exact symptom,
  which previously returned 403 `INVALID_REQUEST_ORIGIN` on every mutation route.
- Production `/login` contains no occurrence of the shared demo password.
- Signing in from two devices listed both with the caller's marked current; signing out
  the others revoked exactly one and left the caller signed in.
- A session aged past 60 minutes of inactivity was rejected with 401 while its absolute
  expiry was still hours away.
- With an unreachable database, the health check logged one JSON line naming only
  `PrismaClientInitializationError` and `redacted: true`; the connection string's password
  appeared nowhere in the output.

The database-backed `npm run test:public-*` scripts were not run; they need a running dev
server as well as a database.
