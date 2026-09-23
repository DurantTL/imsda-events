# WR26 go-live review — what actually stands between here and the retreat

Prepared September 21, 2026, against `main` at `f66c50e` (66 migrations on disk).

This is a **review and roadmap only. No code changes are proposed or made here.**

It is narrower than [`WOMENS-RETREAT-ROADMAP.md`](WOMENS-RETREAT-ROADMAP.md), which asks
"what is left to build?" This one asks a different question: **on the day registration
opens and on the morning of the retreat, what breaks?** The answers turned out not to be
feature gaps. They are configuration, scheduling, and evidence gaps in the deployed
environment — the parts the repository cannot prove about itself.

Issue [#98](https://github.com/DurantTL/imsda-events/issues/98) remains the canonical
ordered backlog. GitHub is authoritative for scope once an issue is approved.

---

## Verdict

**The application is ready. The deployment around it has not been proven, and three of
its unattended jobs may not be running at all.**

Verification performed for this review, in this workspace:

```
npx vitest run          ✅ 1428 passed (209 files)
git status              ✅ clean working tree
prisma/migrations       66 committed migrations
```

The registration-through-check-in path is genuinely complete and well tested: serializable
capacity and waitlist, immutable form versions and answer snapshots, Square Sandbox
checkout with signed and deduplicated webhooks, fifteen versioned templates on a
transactional outbox, signed PII-free QR passes, offline-recoverable check-in, program
assignment runs, and grouped printable packets. That is the expensive part and it is done.

**There is no WR26 feature work left that automation can claim.** All 112 open
`codex-ready` issues are Phase 2 and Phase 3 breadth — meals, transportation, wallets,
passkeys, site builder, mobile. Not one of them is on the retreat's path. Everything
remaining for WR26 is human operational work, which is exactly why it has been the
slowest part: it cannot be delegated to a build loop.

The findings below are ranked by what they cost if they are wrong on the day.

---

## F1 — Rate limiting silently collapses into one site-wide bucket unless a variable nobody is required to set is set

**Severity: highest. This is the one that takes down registration-opening day.**

`RATE_LIMIT_TRUSTED_PROXY_HOPS` defaults to `0` (`modules/rate-limit/domain.ts:61`), and
`.env.example:35` ships `0`. When it is `0`, `trustedClientIp` returns `null` immediately
(`modules/rate-limit/domain.ts:59-60`) — it never even reads a forwarding header.

In production, a request whose client IP cannot be resolved does not get a free pass. It
is deliberately **fail-closed** into a single shared bucket
(`modules/rate-limit/domain.ts:163-168`):

```
return hashRateLimitIdentifier("unresolved-production-client", "shared", configuration);
```

That is the correct security decision — trusting a spoofable header would be worse. But it
means that if the variable is unset in the xCloud env panel, **every visitor in the world
shares one rate-limit identity**, and the per-client limits become site-wide limits:

| Policy | Limit | What it becomes site-wide |
| --- | --- | --- |
| `public.registration.client-form` (`service.ts:446`) | 5 per 15 min | **The 6th registration on the form, by anyone, is refused** |
| `public.registration.client` (`service.ts:440`) | 12 per 15 min | 12 total submissions across all forms |
| `attendee.sign-up.client` (`service.ts:167`) | 10 per hour | 10 attendee accounts per hour, total |
| `attendee.password-reset.client` | 10 per hour | 10 resets per hour, total |
| `auth.login.client` (`service.ts:65`) | 20 per 15 min | 20 staff sign-in attempts, total |

The failure looks like "the registration form keeps saying too many requests" and it
arrives precisely when traffic is highest. It is also nearly invisible in testing, because
one person registering one household never trips it.

The deploy doc does document the variable correctly — "1 for a single Nginx; 2 if
Cloudflare is also in front" — but it sits in the **optional / conditional** block
(`docs/DEPLOY-DOCKER.md`, Environment variables), below a required block the app enforces
at startup. Everything the app refuses to boot without is set. This one it boots happily
without.

**What to do, before registration opens:**

1. Read the current value in the xCloud env panel. If it is absent or `0`, this finding is
   live right now.
2. Set it to the true number of trusted proxies in front of the app. The deploy notes
   reference both Cloudflare and xCloud's Nginx; if both are in the path, that is `2` with
   `x-forwarded-for`, or `RATE_LIMIT_CLIENT_IP_HEADER=cf-connecting-ip` with hops `1`.
   Guessing high is not safe either — an over-large hop count reads an IP the client can
   forge.
3. Prove it with two browsers on two different networks: submit six test registrations
   from one, confirm the other is still accepted. If the second is refused, the hop count
   is still wrong.
4. Separately decide whether **5 per 15 minutes per IP per form** is right for WR26 even
   when correctly configured. A church coordinator registering six women one at a time
   from the church office wifi will hit it. Group and household registration is the
   intended path for that, but coordinators often do not use it.

---

## F2 — Every unattended job in the system hangs off one container the production deployment probably does not run

`POST /api/internal/outbox/sweep` (`app/api/internal/outbox/sweep/route.ts`) does three
things on every call:

1. `sweepOutbox()` — retries queued email that failed a first attempt, for **both** the
   event queue and the account queue (activation and password reset).
2. `runAlertScan()` — raises every operational alert except one.
3. `pruneExpiredCommunityContent()` — community retention cleanup.

Its only caller in the entire deployment is the `outbox-sweeper` service in
`docker-compose.yml:106-118`. There is no scheduled GitHub workflow; `.github/workflows/`
contains only `ci.yml`.

But production is an xCloud **Dockerfile-only** site, and per `docs/DEPLOY-DOCKER.md`
that site type regenerates its own Compose file from the Dockerfile — it is not running
the repository's `docker-compose.yml`. Two pieces of evidence that only the app container
is being managed:

- `scripts/xcloud-post-deploy.sh:10` — `IMSDA_XCLOUD_SERVICE="${IMSDA_XCLOUD_SERVICE:-app}"`,
  and line 116 recreates only that one service.
- The documented emergency **manual rebuild-and-swap** starts a single container with
  `docker run --name xcloud-site-<id>-app-1 ... imsda-events:manual-<sha>`. No sweeper.

**If the sweeper is not running in production:**

- Email that fails its first delivery attempt is **never retried** without a staff member
  opening Communications and clicking the process button. That includes staff account
  activation and password reset, which have no manual alternative.
- **No operational alert is ever raised**, because the scan runs at the end of the sweep.
- Community retention never runs.

**What to do, this week:** on the production host, `docker ps` and look for a sweeper
container. If it is absent, the fix does not require a code change — a host `cron` entry
hitting `POST /api/internal/outbox/sweep` with the `OUTBOX_SWEEP_TOKEN` bearer token every
five minutes restores all three behaviors. Then confirm it works by reading the JSON the
endpoint returns. The same question applies to the `backup` service (see F5).

This should be written down in the runbook as a thing that can silently stop, because on
this site type it can.

---

## F3 — The alerting system cannot report its own death, and nothing is watching the health endpoint

This follows from F2 and is worth stating separately, because it is the reason F2 could
already be true today without anyone knowing.

Every alert in the table in `docs/DEPLOY-DOCKER.md` — email falling behind, a message that
gave up after five attempts, a failed card payment, and **a card payment that never
reached a result after fifteen minutes (which is what a missing Square webhook looks like
from the inside)** — is raised by the alert scan, which runs only at the end of the sweep.
The single exception is "the database is unreachable," raised from `/api/health`.

So the monitor and the thing being monitored are the same process. If the sweep stops, the
system goes quiet rather than loud.

There is also **no heartbeat**: a search across `modules/`, `app/`, `lib/`, and
`prisma/schema.prisma` for `lastSweep`, `sweptAt`, `lastRunAt`, or `heartbeat` returns
nothing. Nothing records when the sweep last succeeded, so a healthy-looking queue with a
dead sweeper is indistinguishable from a healthy one — until something fails and then sits
there.

And `docs/DEPLOY-DOCKER.md` never mentions an uptime monitor. Nothing external polls
`/api/health` at all.

**What to do, before registration opens:**

1. Point any external uptime monitor at `https://events.imsda.org/api/health` with alerting
   to a phone that will be answered. This is the single highest-value 10-minute task in
   this document. It covers the database, and `messageOutbox.oldestDueAgeMs` gives an
   indirect read on whether the sweep is alive.
2. Set `ALERT_WEBHOOK_URL` to a Slack or Teams webhook that the retreat team actually
   watches, if it is not already set. An alert with nowhere to go is a log line.
3. During registration and through the retreat, have one named person check `/api/health`
   once a day. It is a five-second curl and it is the only thing that catches a stopped
   sweeper.

A "last successful sweep" timestamp on the health response would close this properly, but
that is a code change and therefore post-retreat work, not a pre-launch action.

---

## F4 — The documented emergency deploy procedure loses every uploaded event file

Uploaded event assets live in the `imsda_events_assets` named volume, mounted into the app
at `/app/storage/event-assets` (`docker-compose.yml:88-89`).

The **manual rebuild-and-swap** in `docs/DEPLOY-DOCKER.md` — the procedure to use when the
xCloud site stops regenerating its Compose file, which has already happened — starts the
replacement container with `--name`, `--restart`, `-p`, `--network`, and two `--env-file`
flags, and **no `-v` at all**. The new container comes up with an empty
`/app/storage/event-assets`.

Nothing is destroyed — the volume still exists and re-attaching it restores everything —
but the symptom is that every uploaded schedule, flyer, image, and **event badge artwork**
404s, on a container that otherwise looks healthy. Badge artwork is what WR26 prints
attendee passes from (`20260915120000_event_badge_background`), and this procedure is one
that gets run late at night under pressure by someone who has already had a bad evening.

**What to do:** add `-v imsda_events_assets:/app/storage/event-assets` to that documented
`docker run`, and add an asset spot-check to its verification step alongside the existing
`/api/health` check. This is a documentation fix, not a code change, and it takes minutes.
Do it before it is needed rather than during.

---

## F5 — Backups: one verified restore is evidence, not a retention policy

Genuinely good news, recorded in `PRODUCTION-READINESS-PROGRESS.md` §4: on September 21 a
production dump was restored into a scratch database with matching counts
(`Registration=175`, `RegistrationAttendee=238`, `Payment=96`, `MessageOutbox=35`), copied
off-host, and SHA-256 verified at both ends. That is a real restore rehearsal, which most
projects never do.

Two things it does not establish:

- **The dumps still land on the same host as the database.** The outstanding operator
  decision from readiness item 4 is unresolved: bind `imsda_events_backups` to off-host
  storage, or set `BACKUP_OFFSITE_COMMAND` (it receives the dump path as `$1`). A dump
  sharing a host with its source does not survive losing that host. September's off-host
  copy was done by hand for the preflight; nothing does it nightly.
- **Whether the `backup` service is running at all** is the same open question as F2 — it
  is a Compose service on a deployment that may only be running the app container.

**What to do, before registration volume builds:** confirm the backup container exists on
the host, set an off-host destination, and read the logs for `restore-verify` to confirm a
rehearsal has run unattended. A line reading `RESTORE REHEARSAL FAILED` means the backups
are not proven restorable.

---

## F6 — There is still no payment fallback, and the decision is the deliverable

[#327](https://github.com/DurantTL/imsda-events/issues/327) is open, labeled
`needs-decision`, with no `codex-ready`. The public payment page offers only the embedded
Square Web Payments SDK. When it cannot render a method for a registrant — script blocked,
wallet ineligible in that browser, a future SDK regression — the only path today is
"contact the event team."

This was flagged from a live review, so it is not hypothetical: a registrant on desktop
Chrome saw no wallet buttons.

The issue's own handoff requirements are extensive and correct — server-owned hosted order
mapping, idempotent reconciliation, stale-link handling when the balance changes,
fee parity with #317, and Sandbox evidence under #306. That is a real implementation slice,
and it is **not** something to start weeks before a retreat, because two payment entry
points that can both charge the same balance is exactly the kind of change that needs time
to be wrong in safely.

**Recommendation: accept the deferral for WR26 and make the operator path explicit.** The
platform already has manual cash and check payment recording, pay-later balance links, and
staff-mediated payment help. What is missing is not code — it is a written answer to "a
registrant says the card form will not load, now what?" and a named person who owns it
during registration.

Either way, #306 requires an explicit recorded disposition. Writing "deferred, with an
operator payment-help path, owned by X" closes that checkbox honestly. Describing a hosted
fallback as shipped would not.

---

## F7 — Twenty-one migrations have landed since the last recorded configuration and migration review

`docs/PRODUCTION-READINESS-PROGRESS.md` records verification against "all 45 migrations
applied." There are now **66** committed migrations. #306 still carries the unchecked
acceptance criterion "production configuration and migration review, including migration
45 and a written rollback / forward-fix path."

#306's September 21 handoff already corrects the stale wording and names the real work:
review every migration between the deployed and target releases, including badge artwork,
payment-attempt surcharge, and identity changes. One of those carries actual data risk and
is called out by name:

> Specifically verify the #328 assumption about editing an unapplied identity migration
> before applying to an existing database.

`20260916110000_identity_account_links_and_household_effective_dates` is the migration in
question. An assumption about editing an unapplied migration is the kind of thing that is
fine until the target database turns out to have already applied it.

**What to do:** this is the highest-skill item on the list and the one least suited to
being done the week of the retreat. Diff the deployed release against the target, read
every migration in between, and write the rollback/forward-fix path down. Do it now, while
there is time to discover a problem.

---

## F8 — The status documents now contradict each other and the code

Not a launch blocker. It matters because these documents are what both you and the build
automation read to decide what is true.

- **`docs/AUTOMATION-RUNBOOK.md`** ends by calling
  `BUILD-STATUS-AND-WR26-GAP-AUDIT.md` "the canonical roadmap." `AGENTS.md` says issue #98
  is canonical and that file is "historical status evidence, not the roadmap." An agent
  reading the runbook will work from the wrong list.
- **`docs/WOMENS-RETREAT-ROADMAP.md` §4.2** still states there is "no cursor pagination;
  the board still hard-caps at 50 top-level posts and 100 replies." That shipped:
  `modules/community/repository.ts` now uses `cursor` with `take: 26` at lines 176-178,
  266-268, and 347-349. [#307](https://github.com/DurantTL/imsda-events/issues/307) is
  closed by [#341](https://github.com/DurantTL/imsda-events/pull/341), so C1 is complete,
  not "partially delivered."
- **`docs/PRODUCTION-READINESS-PROGRESS.md`** reports 45 migrations against 66 on disk.

**What to do:** a fifteen-minute pass over three files, after the retreat unless it is
misleading someone now.

---

## F9 — The merchandise hold is not recorded where the tooling can see it

`WOMENS-RETREAT-ROADMAP.md` §2.1 held merchandise for WR26 and §7 lists the follow-through
as unchecked: record the hold on #54, #146, #147, and #148, and decide what happens to
draft PR [#302](https://github.com/DurantTL/imsda-events/pull/302).

None of that has happened. All four issues are still open with `phase-0` labels, #302 has
been open and untouched since September 14, and draft PR #321 (consent policies) is in the
same state. The roadmap itself names the risk: leaving `codex-ready` on held work lets an
automated build claim it.

**What to do:** comment the hold on the four issues, remove `codex-ready` where present,
and decide — finish, park, or close — on #302 and #321. Low effort, removes a whole class
of accident.

---

## F10 — The staff runbook and event-day sign-off have no owner and no date

This is the last functionally unchecked item on #306, and it is the one that most directly
determines whether the retreat *feels* like it runs well.

Everything above is about the system. This is about the people operating it at 7:30 on a
Friday morning when the check-in tablet will not scan. What it needs to contain:

- Who is on call, with a phone number, for the duration of registration and the retreat.
- What to do when the QR scanner fails. (The answer exists — manual lookup and the offline
  queue — but it needs to be on paper in the hands of whoever is at the table.)
- What to do when a registrant cannot pay. (See F6.)
- Who may issue a refund, and who approves it. Refunds are a human-only gate per
  `AGENTS.md`; the retreat needs to know which human.
- How to reach the health endpoint and what a bad answer looks like.
- Printed fallbacks: the grouped retreat packets and roster exist and print. Print them
  before the event, not during it. If the network is down, paper is the system.

---

## What is deliberately not on this list

- **Field-level encryption of medical and screening answers.** Removed from the retreat
  release gate by a recorded decision. Existing access controls, redaction, backups, and
  restricted handling still apply. Not reopened here.
- **Merchandise (#54, #146–#148).** Held. Shirt sizes are collected as ordinary
  registration answers and already flow to the packet and shirt-size reports, so the hold
  removes no shipped retreat capability.
- **Community depth beyond what shipped** — reactions, profiles, attendee directory,
  groups, media. C1 and C2 are complete and that is a perfectly good retreat community.
  C4 (moderation depth) and C9 (lifecycle and clone behavior) are the next ones worth
  having, and neither is a launch blocker.
- **Square production unlock.** A separate named human decision, correctly locked behind
  both `SQUARE_ENVIRONMENT=production` and `SQUARE_ENABLE_PRODUCTION=true`
  (`lib/env.ts` and `modules/payments/square-config-domain.ts`), with the startup contract enforcing the pairing.

---

## Roadmap

Ordered by when it has to happen, not by size. Every item is operational; none requires a
feature build.

### Block 1 — Before registration opens (config verification, hours not days)

| # | Action | Finding | Who |
| --- | --- | --- | --- |
| 1 | Read `RATE_LIMIT_TRUSTED_PROXY_HOPS` in the env panel; set it to the true hop count; prove it from two networks | F1 | Operator |
| 2 | `docker ps` on the host — confirm the outbox sweeper and backup containers exist; if not, add a host cron hitting the sweep endpoint | F2 | Operator |
| 3 | Point an external uptime monitor at `/api/health`; confirm `ALERT_WEBHOOK_URL` reaches a watched channel | F3 | Operator |
| 4 | Set an off-host backup destination; confirm an unattended restore rehearsal has run | F5 | Operator |
| 5 | Run `npm run event:readiness -- --event <wr26-slug>` and save the output as evidence | — | Automation |

Items 1–3 are the difference between a quiet launch and a loud one. None takes an hour.

### Block 2 — Before the retreat (evidence and decisions, weeks not days)

| # | Action | Finding | Who |
| --- | --- | --- | --- |
| 6 | Migration and configuration review across all 66 migrations, with a written rollback/forward-fix path; verify the #328 identity-migration assumption against the real database | F7 | Engineer + human sign-off |
| 7 | Record the #327 disposition — deferred with a named operator payment-help path is the recommended answer | F6 | Caleb / conference |
| 8 | Complete #140: inspect every required WR26 template in Communications, and run the real-client smoke test (Gmail/Outlook/Apple Mail) for the primary button and remote QR image. Share the evidence with #306 rather than running it twice | — | Human |
| 9 | Fix the `docker run` volume omission in `DEPLOY-DOCKER.md` | F4 | Engineer |
| 10 | Record the merchandise hold on #54/#146/#147/#148; decide on draft PRs #302 and #321 | F9 | Caleb |

### Block 3 — Event week

| # | Action | Finding |
| --- | --- | --- |
| 11 | Write the staff runbook: on-call name and number, scanner failure path, payment-help path, refund authority, health check | F10 |
| 12 | Print the grouped retreat packets, rosters, and a badge sheet. Check artwork, crop, margins, long names, contrast. Confirm events not collecting shirt sizes do not print "Shirt size needed" | F4 |
| 13 | Re-run `event:readiness`; re-check `/api/health` and record the release SHA and build ID actually serving | — |
| 14 | Confirm no retreat workflow depends on a fictitious account or direct database editing (already checked on #306 — re-confirm against the final release) | — |

### Block 4 — Event day

| # | Action |
| --- | --- |
| 15 | Named human records the event-day sign-off on #306 |
| 16 | One person checks `/api/health` morning and evening |
| 17 | Paper fallback in hand at the check-in table |

### Block 5 — After the retreat, while it is fresh

| # | Action | Finding |
| --- | --- | --- |
| 18 | Add a last-successful-sweep heartbeat to `/api/health` so a dead sweeper is visible | F3 |
| 19 | Reconcile the three contradicting status documents | F8 |
| 20 | Generalization: #155, #153, #104 — before Camp Meeting inherits the WR26-shaped hard-coding | — |
| 21 | Community C9 (lifecycle, read-only post-event window, clone behavior), then C4 (moderation depth) once its escalation decision is made | — |
| 22 | Answer the §4.5 community decisions in `WOMENS-RETREAT-ROADMAP.md` — especially minors and safeguarding escalation, which are worth answering even if C5–C8 never ship | — |

---

## Decisions only a human can make

Each of these blocks something above. None of them is automation's to decide.

1. **What is the true proxy hop count in front of the app?** (F1) Blocks item 1. Needs the
   person who configured Cloudflare and xCloud's Nginx.
2. **Is the sweeper expected to run, and if not, where does the schedule live?** (F2)
   Blocks item 2.
3. **Where do backups go off-host?** (F5) Blocks item 4.
4. **#327: fallback or operator path?** (F6) Blocks item 7. Recommendation: operator path
   for WR26.
5. **Who is on call, and who may authorize a refund during the retreat?** (F10) Blocks
   item 11.
6. **Merchandise: finish, park, or close #302?** (F9) Blocks item 10.

Items 1, 2, 3, and 5 are the ones that change what happens on the day.

---

## One-paragraph summary

WR26 does not need more software. It needs someone to open the xCloud env panel and check
one rate-limit variable, run `docker ps` on the host to find out whether the sweeper and
backup containers are actually there, point an uptime monitor at the health endpoint, and
write down who to call when something breaks. Those four things take an afternoon and
address the failure modes that would be most visible and most damaging — registration
refusing everyone on opening day, email retries and alerts silently not running, and
nobody noticing either. The migration review and the #140 email gate are the real
multi-week items and should start now. Everything else on the backlog can wait until after
the retreat, and most of it should.
