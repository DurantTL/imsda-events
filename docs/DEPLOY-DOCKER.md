# Deploying with Docker (xCloud "Deploy Any App From Git" and similar)

The repository ships a production `Dockerfile` and a `docker-compose.yml` that runs
the whole stack — the Next.js app, its PostgreSQL database, a scheduled outbox
sweeper, and a nightly backup job — with one command:

```bash
docker compose up -d --build
```

What happens on `docker compose up`:

1. **postgres** starts (PostgreSQL 16) and becomes healthy.
2. **app** builds from the `Dockerfile`, waits for postgres to be healthy, then its
   entrypoint runs `prisma migrate deploy` before starting `next start` on port 3000.
   The app validates its whole environment before accepting a request and **refuses
   to start** if anything required is missing — see [Environment variables](#environment-variables-set-these-in-the-xcloud-env-panel).
3. **outbox-sweeper** retries queued email that failed a first delivery attempt.
4. **backup** takes a nightly `pg_dump`, archives uploaded event files, and
   periodically rehearses a database restore.

The reverse proxy (xCloud's Nginx) forwards your domain to the app's published port.

## Why the port collision can't happen here (the "port is already allocated" error)

Postgres is reached by the app **internally** as host `postgres`, so `docker-compose.yml`
publishes **no host port for the database at all**. That means it can never collide with
another Postgres already using `5432` on the host (a common shared-server situation).
Local development, which needs host access to the database, layers in
`docker-compose.dev.yml` to publish `5432` — deploy hosts never load that file.

The **app** publishes a web port for the reverse proxy, `3100` by default. If that is
already taken on the host, set `APP_PORT` to a free port and point the proxy at that.

## Environment variables (set these in the xCloud env panel)

Use `KEY=value` lines in the deployment environment. Do not commit the
production values to this repository.

**Required for production** — the app will not start without all of these:

```
APP_BASE_URL=https://your-final-domain
POSTGRES_PASSWORD=<openssl rand -hex 32>
MANAGE_LINK_DERIVATION_SECRET=<openssl rand -base64 48>
ATTENDEE_PASS_SIGNING_SECRET=<openssl rand -base64 48>
RATE_LIMIT_HASH_SECRET=<openssl rand -base64 48>
OUTBOX_SWEEP_TOKEN=<openssl rand -base64 48>
SECRET_ENCRYPTION_KEY=<openssl rand -base64 48>
RESEND_API_KEY=<from the Resend dashboard>
ACCOUNT_EMAIL_SENDER_ADDRESS=<a verified sender, e.g. no-reply@imsda.org>
```

Each secret needs at least 32 characters. If one is missing or malformed the
container exits at startup with the offending variable named in its log, rather
than serving pages and failing later on a QR pass or a private link. A variable
that is absent from the panel altogether stops `docker compose up` before it
builds, naming the variable in the deploy output.

> **Upgrading an existing deployment:** the required list has grown.
> `OUTBOX_SWEEP_TOKEN` arrived with the scheduled outbox sweeper,
> `SECRET_ENCRYPTION_KEY` with two-factor authentication, and `RESEND_API_KEY`
> with `ACCOUNT_EMAIL_SENDER_ADDRESS` when account email became the only way an
> invited colleague receives a link. A deployment that predates any of them must
> add it before its next deploy, or the app container will refuse to start.

`SECRET_ENCRYPTION_KEY` seals the TOTP secrets behind two-factor
authentication and every club roster birth date (ADR 0005 Addendum A).
**Changing it makes every enrolled authenticator unreadable and loses every
roster birth date for good.** Never change it without the re-seal procedure and
the key backup in `docs/SERVER-SECURITY-CHECKLIST.md` (items 2, 3, 9, and 11).

The last two are what send activation and password-reset email. They are
required rather than optional because there is no manual substitute at scale: an
invited colleague who never receives a link cannot obtain a credential at all.
The address must be verified with Resend, or every account email fails at the
provider. `ACCOUNT_EMAIL_SENDER_NAME` defaults to `IMSDA Events`, and
`ACCOUNT_EMAIL_REPLY_TO` is optional.

`NODE_ENV` and `DATABASE_URL` are set by `docker-compose.yml` — you do **not**
provide `DATABASE_URL` here.

`APP_RELEASE_SHA` is operational metadata, not a secret. When supplied, it must
be a 7–64 character hexadecimal Git SHA. `/api/health` returns it together with
the immutable Next.js build ID so an operator can verify what is actually
running. The xCloud repair script copies `XCLOUD_DEPLOYED_COMMIT` into
`APP_RELEASE_SHA` when xCloud exposes that value.

**Optional / conditional:**

```
APP_PORT=3100                    # only if host 3100 is already in use
APP_RELEASE_SHA=                 # optional 7–64 character Git SHA; see release health below
ALERT_WEBHOOK_URL=               # Slack/Teams incoming webhook; see Alerting below
ALERT_REPEAT_MINUTES=60          # how long the same condition stays quiet after paging
PASSWORD_BREACH_CHECK=           # enabled/disabled; unset means on in production
ACCOUNT_EMAIL_SENDER_NAME=IMSDA Events
ACCOUNT_EMAIL_REPLY_TO=
RATE_LIMIT_TRUSTED_PROXY_HOPS=1  # 1 for a single Nginx; 2 if Cloudflare is also in front
RATE_LIMIT_CLIENT_IP_HEADER=x-forwarded-for   # cf-connecting-ip behind Cloudflare
OUTBOX_SWEEP_INTERVAL_SECONDS=300
BACKUP_RETENTION_DAYS=14
BACKUP_VERIFY_EVERY=7            # rehearse a restore every Nth backup
BACKUP_OFFSITE_COMMAND=          # receives each database/asset backup path as $1
GOOGLE_OAUTH_CLIENT_ID=          # set both Google values or leave both blank
GOOGLE_OAUTH_CLIENT_SECRET=
EMBED_ALLOWED_ORIGINS='self' https://imsda.org https://*.imsda.org
```

Add each approved church website origin to `EMBED_ALLOWED_ORIGINS`; do not use
a bare `*`. The embed response uses this value for CSP `frame-ancestors` and does not
send a conflicting `X-Frame-Options: SAMEORIGIN` header. Because the public
registration POST is stateless, it does not require a `SameSite=None` session
cookie inside the third-party frame.

(There is no `POSTGRES_HOST_PORT` to set for deployment — the database is not published
to the host at all. That variable only matters for the local `docker-compose.dev.yml` overlay.)

Email (Resend) and Square are left disabled unless you supply their credentials;
Square stays in Sandbox until `SQUARE_ENVIRONMENT=production` **and**
`SQUARE_ENABLE_PRODUCTION=true` are both set. See the main README for those.

## Permanent xCloud Dockerfile-only runtime override

xCloud's Dockerfile-only site type regenerates
`/home/u_events/.xcloud/docker-compose.yml` during every deployment. A separate
`docker-compose.env.yml` override is not loaded by that generated command, so
the newly created app container loses both `DATABASE_URL` and its external
PostgreSQL network unless the override is reapplied.

Keep these server-owned files in `/home/u_events/.xcloud`:

- `.env` — mode `600`, containing the production environment.
- `docker-compose.env.yml` — adds `.env` through `env_file` and attaches the
  external PostgreSQL network.

The app service in `docker-compose.env.yml` must also map the release value; an
`env_file` alone cannot see xCloud’s shell-only deployment variable:

```yaml
services:
  app:
    env_file:
      - .env
    environment:
      APP_RELEASE_SHA: ${APP_RELEASE_SHA:-}
    networks:
      - default
      - postgresql

networks:
  postgresql:
    external: true
    name: postgresql_9kgaw_239292_xcloud-network
```

Then configure the xCloud site's **Deployment Script** to run:

```bash
IMSDA_XCLOUD_RUNTIME_DIR=/home/u_events/.xcloud IMSDA_XCLOUD_EXPECTED_NETWORK=postgresql_9kgaw_239292_xcloud-network sh "$PROJECT_DIR/scripts/xcloud-post-deploy.sh"
```

xCloud runs this hook after each deployment. The script validates the base
Compose file, override, and environment without printing secret values; safely
recreates only the `app` service with both Compose files; and fails the
deployment if the resulting container is missing `DATABASE_URL` or the expected
database network.

Some Dockerfile-only xCloud sites do not execute the configured Deployment
Script. When the deployment log does not contain any `[xcloud-post-deploy]`
lines, install the server-level guard instead:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/DurantTL/imsda-events/main/scripts/install-xcloud-runtime-guard.sh \
  --output /tmp/install-imsda-xcloud-runtime-guard.sh

sh /tmp/install-imsda-xcloud-runtime-guard.sh
```

Run those commands as `root`. The installer copies the repair hook to
`/usr/local/sbin`, creates a systemd oneshot service and 30-second timer, and
runs the first check immediately. The check is idempotent: while the app already
has `DATABASE_URL` and the expected PostgreSQL network, it makes no container
change. After xCloud recreates a base-only container, the next timer run restores
the override. If the timer wakes while xCloud has no app container, it defers
rather than starting a competing build.

Verify it with:

```bash
systemctl status imsda-xcloud-runtime-guard.timer --no-pager
journalctl -u imsda-xcloud-runtime-guard.service -n 50 --no-pager
```

The cleaner long-term alternative is an xCloud **Custom Docker → Docker Compose
From Git** site using the repository's Compose file and xCloud's Environment
File option. That site type natively loads a named Compose file and should be
preferred when replacing this Dockerfile-only site. The post-deployment hook
keeps the current site reliable without another database or domain move.

### Protecting the override files from the host's 30-day cleanup script

The production host runs `/root/xcloud-cleanup.sh` daily at 13:12, which
deletes anything under any site's `.xcloud/` directory that hasn't been
modified in 30 days. That sweep does not know these three files are a
permanent, hand-maintained override rather than deploy scratch space, so it
will delete `.env`, `docker-compose.yml`, and `docker-compose.env.yml` out
from under a site that hasn't deployed (and therefore hasn't touched them)
in a month.

Install a daily touch job as `root` to keep them exempt:

```bash
cat > /etc/cron.d/imsda-xcloud-touch <<'EOF'
# Keep the persistent xCloud runtime override files from being swept by
# /root/xcloud-cleanup.sh's blanket "delete anything in .xcloud/ older than
# 30 days" logic — see docs/DEPLOY-DOCKER.md for why these files must persist.
0 5 * * * root touch /home/u_events/.xcloud/.env /home/u_events/.xcloud/docker-compose.yml /home/u_events/.xcloud/docker-compose.env.yml 2>/dev/null
EOF
chmod 644 /etc/cron.d/imsda-xcloud-touch
```

Files dropped into `/etc/cron.d/` are picked up automatically; no cron
restart needed. Verify with `cat /etc/cron.d/imsda-xcloud-touch` (expect 4
lines: 3 comment lines + 1 cron line) or `cat -A` if a terminal seems to be
wrapping the line and you want to confirm it wasn't actually truncated.

If `docker-compose.yml` doesn't currently exist on the host (see the
incident below), that particular path in the `touch` command is a harmless
no-op until the file is restored — leave it in the list as-is.

### When the Dockerfile-only site stops regenerating `docker-compose.yml` at all

Occasionally this site type stops writing `/home/u_events/.xcloud/docker-compose.yml`
on deploy entirely — the dashboard's **Deploy** button reports success (or an
`empty compose file` error) but the file is missing or empty afterward, and
neither `scripts/xcloud-post-deploy.sh` nor the systemd guard above can help,
because both depend on xCloud having produced *some* base Compose file to
patch. When this happens, **file an xCloud support ticket** — this is a
platform-level regression, not something fixable from inside the site — and
until it's resolved, every deploy needs the manual rebuild-and-swap below
instead of the dashboard Deploy button.

#### Manual rebuild-and-swap

This builds a fresh image from the current checkout, keeps the old container
as a renamed (not deleted) safety net, and starts the new one wired
identically to the old — same published port, same two networks, same
restart policy. Run as `root` on the host. Substitute the actual container
name (`docker ps` shows it; the pattern is `xcloud-site-<id>-app-1`), the
site's internal Compose network name, the shared Postgres network name from
the override file above, and the commit SHA being deployed.

1. **Capture the live `DATABASE_URL`** from the still-running container to a
   protected file — never to the screen, since it contains the database
   password:

```bash
   umask 077
   docker inspect xcloud-site-<id>-app-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep '^DATABASE_URL=' > /home/u_events/.xcloud/.env.dburl
   chown u_events:u_events /home/u_events/.xcloud/.env.dburl
   chmod 600 /home/u_events/.xcloud/.env.dburl
```

2. **Build the new image from the current checkout:**

```bash
   cd /var/www/events.imsda.org
   docker build -t imsda-events:manual-<short-sha> .
```

   Check the build actually finished (and didn't error) before continuing.

3. **Rename the old container instead of removing it**, so rollback is one
   command:

```bash
   docker stop xcloud-site-<id>-app-1
   docker rename xcloud-site-<id>-app-1 xcloud-site-<id>-app-1-old
```

4. **Start the new container**, replicating the old one's exact port,
   network, and restart configuration:

```bash
   docker run -d \
     --name xcloud-site-<id>-app-1 \
     --restart unless-stopped \
     -p 127.0.0.1:8100:3100 \
     --network xcloud-site-<id>_default \
     --env-file /home/u_events/.xcloud/.env \
     --env-file /home/u_events/.xcloud/.env.dburl \
     -v imsda_events_assets:/app/storage/event-assets \
     -e NODE_ENV=production \
     -e PORT=3100 \
     -e APP_RELEASE_SHA=<full-sha> \
     imsda-events:manual-<short-sha>

   docker network connect postgresql_9kgaw_239292_xcloud-network xcloud-site-<id>-app-1
```

5. **Verify:**

```bash
   docker logs -f xcloud-site-<id>-app-1
   # once it looks up and serving, Ctrl-C, then:
   curl -s http://127.0.0.1:8100/api/health
```

   Confirm `status: ok`, the expected `release.sha`, and `database`/
   `messageOutbox` both `ok`. Then check `https://events.imsda.org` through
   the real domain (Cloudflare/Nginx), not just the internal `curl`, to
   confirm routing actually reached the new container — and spot-check
   whatever feature the deploy was for.

   Also open one uploaded file — the event badge artwork or a schedule on the
   event page. The `-v imsda_events_assets:...` line above is what attaches the
   uploads volume; a container started without it looks healthy but serves a
   404 for every uploaded file. Nothing is lost: stop it and start it again
   with the volume.

**Rollback**, if anything looks wrong:

```bash
docker stop xcloud-site-<id>-app-1
docker rm xcloud-site-<id>-app-1
docker rename xcloud-site-<id>-app-1-old xcloud-site-<id>-app-1
docker start xcloud-site-<id>-app-1
```

**Cleanup**, once the new container is confirmed good (the `-old` container
can be kept a day or two first for extra insurance, no rush):

```bash
docker rm xcloud-site-<id>-app-1-old
rm -f /home/u_events/.xcloud/.env.dburl
```

A `messageOutbox` `failed` count greater than zero in the health check is
usually pre-existing and unrelated to the deploy itself — worth a look in the
admin/ops view separately, but not a reason to roll back.

## Moving to a clean server and a new URL

This deployment is designed to start from an empty server. It does not need a
database dump when the old data is intentionally being discarded:

1. Install Docker Engine with the Compose plugin, clone this repository, and set
   the production environment variables. Generate new values for all five
   application secrets and `POSTGRES_PASSWORD`; do not copy old values when no
   old sessions, private links, QR passes, or MFA enrollments need to survive.
2. Set `APP_BASE_URL` to the final HTTPS origin, with no trailing path. Set
   `SQUARE_WEBHOOK_NOTIFICATION_URL` to
   `<APP_BASE_URL>/api/webhooks/square`.
3. Point DNS at the new server and configure its TLS reverse proxy to forward to
   `APP_PORT` (`3100` by default).
4. Update the external providers that know the old URL:
   - Google OAuth authorized redirect URI:
     `<APP_BASE_URL>/api/attendee/oauth/google/callback`
   - Square webhook notification URL:
     `<APP_BASE_URL>/api/webhooks/square`
   - Resend webhook URL:
     `<APP_BASE_URL>/api/webhooks/resend`
5. Run `docker compose up -d --build`. Postgres creates an empty database in the
   `imsda_events_postgres` volume; the app waits for it, applies every committed
   Prisma migration, and then starts. There is no demo seed.
6. Confirm the stack before importing anything:

   ```bash
   docker compose ps
   docker compose exec app npx prisma migrate status
   curl --fail https://your-new-domain/api/health
   ```

7. Create the first administrator as described below. Create or configure the
   Women's Retreat event, then use **Imports** to preview and commit the
   registration CSV again. Re-enter event messaging settings and re-upload
   schedules, flyers, or images; uploaded files are now kept in the separate
   `imsda_events_assets` volume.
8. Keep Square in Sandbox, complete a registration/payment/webhook test, and
   only consider the separate production unlock after reconciliation passes.

Changing `APP_BASE_URL`, `EMBED_ALLOWED_ORIGINS`, or the Square environment
requires `docker compose up -d --build`, not only a container restart. Those
public values are used while Next compiles metadata and security headers and are
also supplied again at runtime.

Ordinary rebuilds and `docker compose down` preserve all three named volumes.
`docker compose down --volumes` deliberately erases the database, uploaded
files, and on-host backups; use it only while this intentionally disposable
clean deployment is still being rebuilt.

## First-deploy checklist

1. Set the required env vars above.
2. Deploy. Watch the logs for `Applying database migrations...` then `Starting`.
   A startup failure names the environment variable that caused it.
3. `GET /api/health` should return `{"status":"ok"}` with `database` and
   `messageOutbox` both `ok`, plus `release.buildId` and, when configured,
   `release.sha`. Record both values in the deployment log:

   ```bash
   curl --fail --silent https://your-final-domain/api/health | jq '.status, .release'
   ```
4. Create the first real administrator. The database starts empty and there is no
   first-run setup screen, so this is the supported way in:

   ```bash
   docker compose exec app npm run admin:create -- \
     --email you@imsda.org --name "Your Name"
   ```

   It prints a one-time activation URL. Open it and choose a password. The link is
   shown once — only its digest is stored — and expires after seven days. The
   account cannot sign in until it is activated.

   If opening a link is impractical — the domain is not live yet, or account
   email is not configured — set the password directly instead:

   ```bash
   docker compose exec -e IMSDA_ADMIN_PASSWORD='<a long passphrase>' app \
     npm run admin:create -- --email you@imsda.org --name "Your Name" \
     --password-from-env
   ```

   That account is `ACTIVE` immediately. The password is read from the
   environment rather than an argument so it stays out of shell history and
   `ps`, is held to the same policy as any other, and is stored only as its
   scrypt hash. Clear `IMSDA_ADMIN_PASSWORD` afterwards, and change the password
   from the workspace once account email works.
5. Invite colleagues from **Staff access** in the workspace. Each invitation
   emails its own one-time activation link to the person invited; if they lose it
   they can request another from **Forgot password**. (Where account email is not
   configured — development only, since production requires it — the link is
   shown to you once instead, to pass on yourself.)
6. Confirm `APP_BASE_URL` is the final `https` domain before sending any real links.

**There is no seed step, and `RUN_DB_SEED` is no longer supported.** `prisma/seed.ts`
writes fictitious events, people, registrations, payments and a refund, and gives
every account one shared password that is published in this repository. It refuses
to run with `NODE_ENV=production` or against any non-loopback database host.

## Alerting

Set `ALERT_WEBHOOK_URL` to a Slack or Teams incoming webhook — or anything that
accepts a JSON POST — and the deployment will tell you when it is in trouble
instead of waiting for someone to notice.

What pages, and when:

| Condition | Severity | Raised by |
| --- | --- | --- |
| The database is unreachable | urgent | `/api/health`, on every failed check |
| Email delivery is falling behind (25+ due, or 30 minutes waiting) | urgent | the sweep, every run |
| A message gave up after all five attempts | urgent | the sweep |
| A card payment failed | urgent | the sweep |
| A card payment never reached a result after 15 minutes | urgent | the sweep — this is usually the Square webhook not arriving |
| A Square webhook failed signature verification | urgent | the webhook, immediately |
| A Resend webhook failed verification | watch | the webhook, immediately |

The scan runs at the end of the outbox sweep, so its frequency is
`OUTBOX_SWEEP_INTERVAL_SECONDS` (300 by default).

Because the scan rides on the sweep, **a sweep that stops cannot alert about
itself.** Each successful sweep therefore records when it finished, and
`/api/health` reports it as `outboxSweep`: `ok`, `stale` (no successful sweep
for 15 minutes — three missed five-minute runs), `failing` (the latest run
failed), or `never` (nothing has reported since this was added). `stale` and
`failing` turn the health `status` to `degraded` while still answering 200, so
an external uptime monitor watching `/api/health` for anything other than
`"status":"ok"` is what catches a stopped sweeper. The System command center
shows the same signal. Whatever runs the sweep on the host — the Compose
`outbox-sweeper` service or a cron entry — must `POST` to
`/api/internal/outbox/sweep` with the `OUTBOX_SWEEP_TOKEN` bearer token for
any of this to register. A condition that persists pages
once per `ALERT_REPEAT_MINUTES` (60 by default) rather than every run; when it
stops being true it is cleared, so a recurrence pages immediately.

Every alert is also written to the log as a JSON line carrying `alertKey` and
`severity`, at error level for urgent ones. A deployment with no webhook set
still leaves that trail for a log aggregator to match on — but nothing will be
watching it, which is the state this replaced.

## Two-factor authentication

System administrators and event administrators must carry a second factor. The
enforcement is at sign-in: a correct password for one of those accounts produces
a **challenge**, not a session, and an account that has never enrolled is sent to
enrol inside that challenge. There is no state in which one of these accounts is
signed in on a password alone.

Everyone else may enrol voluntarily from **More → Two-factor authentication**.

Each enrolment issues ten single-use recovery codes, shown once. If an
administrator loses both their authenticator and their codes, an operator with
shell access can clear the enrolment:

```bash
docker compose exec app npm run admin:reset-mfa -- --email them@imsda.org
```

That signs out every session for the account and requires a fresh enrolment on
its next sign-in, because the role still demands one.

## Troubleshooting a failed deploy

### `dependency failed to start: container ...-app-1 is unhealthy`

The app container started but never passed its health check, so the services that
wait on it (`outbox-sweeper`) stayed in `created`. The deploy output does not
carry the reason — the app log does:

```bash
docker compose logs app --tail 50
```

In xCloud, the same thing is under **Logs → Docker Compose Log →
`...-app-1`**.

The two things that put it there:

- **A missing or too-short environment variable.** The log opens with
  `Refusing to start: the environment is not valid for production.` followed by
  one line per offending variable. Add it in the env panel and deploy again.
  The ones that catch a deployment created before they existed are
  `OUTBOX_SWEEP_TOKEN`, `SECRET_ENCRYPTION_KEY`, `RESEND_API_KEY`, and
  `ACCOUNT_EMAIL_SENDER_ADDRESS`.
- **A migration that could not be applied.** The log stops after
  `Applying database migrations (prisma migrate deploy)...` with a Prisma error.

The health check itself allows 40 seconds of start-up before its first probe and
then retries for a further two and a half minutes, so a slow first boot is not
the cause.

### `error: OUTBOX_SWEEP_TOKEN: set this to at least 32 random characters ...`

`docker compose` refused to build at all because a required variable is absent
from the environment. This is the same fault as above, caught earlier and stated
plainly. Add the named variable and deploy again.

## Backups and restore rehearsals

The `backup` service writes PostgreSQL custom-format dumps and
`imsda-assets-*.tar.gz` upload archives to the `imsda_events_backups` volume,
checks that each asset archive is readable, prunes both sets after
`BACKUP_RETENTION_DAYS`, and every `BACKUP_VERIFY_EVERY` runs restores the newest
database dump into a scratch database and prints its row counts.

**Two things still need a decision from you:**

- **Get the dumps off the host.** Bind `imsda_events_backups` to off-host storage,
  or set `BACKUP_OFFSITE_COMMAND` (it receives the dump path as `$1`, e.g.
  `rclone copy $1 remote:imsda-backups`). A dump sitting on the same host as the
  database it came from does not survive losing that host.
- **Read the rehearsal output.** Search the logs for `restore-verify`. A line
  reading `RESTORE REHEARSAL FAILED` means the backups are not proven restorable.

To restore for real, into the live database:

```bash
docker compose stop app
docker compose exec backup pg_restore --dbname=imsda_events --clean --if-exists \
  --no-owner --no-privileges /backups/imsda-events-<stamp>.dump
docker compose start app
```

Restore a matching uploaded-file archive while the app is stopped:

```bash
docker compose stop app
docker compose run --rm --no-deps --entrypoint sh backup -c \
  'find /assets -mindepth 1 -maxdepth 1 -exec rm -rf {} + &&
   tar -xzf /backups/imsda-assets-<stamp>.tar.gz -C /assets'
docker compose start app
```

The database dump and asset archive should come from the same nightly run.

## Default local development is unchanged

For local work you still run only the database and the dev server on the host:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
npm run dev
```
