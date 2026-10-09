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
   entrypoint runs `prisma migrate deploy` and then `npm run club-forms:sync` (club
   form templates, #610) before starting `next start` on port 3000.
   The app validates its whole environment before accepting a request and **refuses
   to start** if anything required is missing — see [Environment variables](#environment-variables-set-these-in-the-xcloud-env-panel).
   The image build skips Next's TypeScript check, which needs more memory than the
   4 GB production server has (pass `--build-arg NEXT_SKIP_BUILD_TYPECHECK=0` on a
   bigger host to keep it). GitHub CI type-checks every commit, so **deploy only
   commits whose CI is green**: a finished image build no longer proves the code
   type-checks.
3. **outbox-sweeper** retries queued email that failed a first delivery attempt, and
   sends the daily location waitlist digest each morning at 7:00 Central
   (see [LOCATION-WAITLISTS.md](LOCATION-WAITLISTS.md)).
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

**Church map locations (optional, off by default)** — `GEOCODING_ENABLED=true`
lets a system administrator click "Find map locations" on the organization
directory. That sends each church's public street address, city, state and ZIP
to the U.S. Census Bureau geocoder, so **the production server needs outbound
HTTPS (port 443) to `geocoding.geo.census.gov`**. No API key is needed. With
the flag unset or `false` nothing is ever sent. If the host cannot be reached
the step reports an error and changes nothing. Leave `GEOCODING_PROVIDER`
unset in production (`fake` is an offline stand-in for local work only). See
[ADR 0014](decisions/0014-church-geocoding.md).

On the production server `SECRET_ENCRYPTION_KEY` does **not** go in this env
file: it is loaded from a root-only file with `SECRET_ENCRYPTION_KEY_FILE`
instead (see "Loading the encryption key from a protected file" below). The plain
variable stays supported for development and for a server that has not moved yet,
but setting both is a startup error.

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
The address must be verified with the active provider (Resend, or the SES
domain; see "Sending email through Amazon SES" below), or every account email
fails at the provider. `ACCOUNT_EMAIL_SENDER_NAME` defaults to `IMSDA Events`, and
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

## Sending email through Amazon SES (#861)

Email can go out through Amazon SES instead of Resend. The conference's SES
account is in **US East (Ohio), `us-east-2`**, with production access and the
verified domains `imsda.org` and `imadventist.org`. The app talks to SES over
SMTP (`email-smtp.us-east-2.amazonaws.com`, port 587, STARTTLS required) with
**IAM SMTP credentials**, not Mail Manager.

**1. Create IAM SMTP credentials** (an AWS administrator does this once):

1. Open the SES console in `us-east-2`, then **SMTP settings**, then **Create SMTP credentials**.
2. Accept the suggested IAM user name (or name it `imsda-events-smtp`) and create it.
3. Download or copy the **SMTP username** and **SMTP password** now. AWS shows the password only once. These are not the IAM access key and secret; an ordinary access key will not work.

**2. Add these lines to the xCloud environment panel** (the values below are placeholders):

```
EMAIL_PROVIDER=ses
SES_REGION=us-east-2
SES_SMTP_USERNAME=<SMTP username from step 1>
SES_SMTP_PASSWORD=<SMTP password from step 1>
```

Optional: `SES_CONFIGURATION_SET=<name>` to tag sends with a configuration set,
and `SES_MAX_SEND_RATE=<messages per second>` (default `10`; keep it at or below
the "maximum send rate" shown on the SES **Account dashboard**). `SES_SMTP_HOST`
and `SES_SMTP_PORT` exist for tests and are left unset. `RESEND_API_KEY` is no
longer required once `EMAIL_PROVIDER=ses`. Redeploy so the container restarts
with the new values.

**3. Check the sender is on a verified identity.** SES refuses mail from an
address that is not on a verified domain or address. The sender used by each
event's message settings, and `ACCOUNT_EMAIL_SENDER_ADDRESS`, must end in
`@imsda.org` or `@imadventist.org` (or be a separately verified address). In the
SES console, **Verified identities** must show that domain as *Verified*.
A rejected sender appears in the message's delivery history as
"sender address is not on a verified domain" and is not retried.

**Send one test message after switching.** Before relying on SES for a real
send, use an event's "send test message" with real delivery (or any single
registration email) to an address you can read, and confirm it arrives from the
expected sender and the delivery log shows provider `SES`. This also proves the
SMTP credentials and the verified sender together.

**What staff will see.**

- Throttling replies from SES ("Maximum sending rate exceeded"), temporary
  authentication failures, and network faults are retried automatically with the
  usual backoff. The app also spaces sends (`SES_MAX_SEND_RATE`).
- A wrong SMTP username or password is checked at the start of each delivery
  run, before any message is picked up. The run stops with one error naming
  `SES_SMTP_USERNAME` and `SES_SMTP_PASSWORD`; every queued message stays
  waiting, no attempt is used up, and nothing is sent. Fix the values, redeploy,
  and the next run sends them.
- A sender address that is not on a verified identity, or an SES rejection
  (554), fails that message for good, with a message saying what to fix.
- When SES reports the **daily sending quota** is used up, the message is
  recorded with the error code `PROVIDER_QUOTA` and follows the normal retry
  schedule. A longer wait for quota errors is tracked in #860. If quota errors
  appear, ask AWS for a higher sending quota.
- **A send that times out can arrive twice.** If the connection drops after SES
  has accepted a message but before the app hears back, the app retries it, and
  the recipient may get two copies. Every message carries an
  `X-IMSDA-Message-Id` header holding the outbox message id; the two copies have
  the same value, which tells a duplicate from two separate messages.

**Switching back.** Set `EMAIL_PROVIDER=resend` (or remove the line) and
redeploy. Resend then sends exactly as before, and `RESEND_API_KEY` is required
again. Resend's delivery and bounce webhooks stay in place but receive nothing
while SES is active. SES bounce and complaint reporting (through SNS) is not
built yet, so the delivery status for SES mail stops at "accepted".

## Permanent xCloud Dockerfile-only runtime override

xCloud's Dockerfile-only site type regenerates
`/home/u_events/.xcloud/docker-compose.yml` during every deployment. A separate
`docker-compose.env.yml` override is not loaded by that generated command, so
the newly created app container loses both `DATABASE_URL` and its external
PostgreSQL network unless the override is reapplied.

Keep these server-owned files in `/home/u_events/.xcloud`:

- `.env` — mode `600`, containing the production environment.
- `.env.dburl` — mode `600`, containing only `DATABASE_URL=...` (used by the
  manual deployments below).
- `docker-compose.env.yml` — adds `.env` and `.env.dburl` through `env_file`
  and attaches the external PostgreSQL network.

The app service in `docker-compose.env.yml` must also map the release value; an
`env_file` alone cannot see xCloud’s shell-only deployment variable:

```yaml
services:
  app:
    env_file:
      - .env
      - .env.dburl
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

`.env.dburl` is a plain `env_file` entry, so it must exist; Compose refuses to
start without it. If `DATABASE_URL` is in `.env`, you can omit the entry.

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
modified in 30 days. That sweep does not know these four files are a
permanent, hand-maintained override rather than deploy scratch space, so it
will delete `.env`, `.env.dburl`, `docker-compose.yml`, and `docker-compose.env.yml` out
from under a site that hasn't deployed (and therefore hasn't touched them)
in a month.

Install a daily touch job as `root` to keep them exempt:

```bash
cat > /etc/cron.d/imsda-xcloud-touch <<'EOF'
# Keep the persistent xCloud runtime override files from being swept by
# /root/xcloud-cleanup.sh's blanket "delete anything in .xcloud/ older than
# 30 days" logic — see docs/DEPLOY-DOCKER.md for why these files must persist.
0 5 * * * root touch /home/u_events/.xcloud/.env /home/u_events/.xcloud/.env.dburl /home/u_events/.xcloud/docker-compose.yml /home/u_events/.xcloud/docker-compose.env.yml 2>/dev/null
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
neither `scripts/xcloud-post-deploy.sh` nor the systemd guard above can repair
a container, because both depend on xCloud having produced *some* base Compose
file to patch. In this mode the guard only checks the app container (set
`IMSDA_XCLOUD_CONTAINER_PATTERN` in `/etc/default/imsda-xcloud-runtime-guard`;
the installer sets it to `xcloud-site-239298-app-1`). It passes while exactly
one matching container is running with `DATABASE_URL` and the PostgreSQL
network. It defers only when no matching container exists but a matching
`-old` container does (a swap in progress). It fails, so the journal shows it,
when there is no matching container at all, when a matching container is not
running, when more than one is running, or when either setting is missing.
**Re-run the installer after this change merges** so production gets the new
script and pattern. When this happens, **file an xCloud support ticket**: this
is a platform-level regression, not something fixable from inside the site.
Until it's resolved, every deploy needs the manual rebuild-and-swap below
instead of the dashboard Deploy button.
A single failed guard run during a manual swap is expected and harmless: it can
happen between the stop and the rename, and between the run and the network
connect.

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
   DBURL=/home/u_events/.xcloud/.env.dburl
   TMP="$(mktemp /home/u_events/.xcloud/.env.dburl.XXXXXX)"
   docker inspect xcloud-site-<id>-app-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep '^DATABASE_URL=' > "$TMP" || true
   if [ -s "$TMP" ] && grep -q '^DATABASE_URL=postgres' "$TMP"; then
     chown u_events:u_events "$TMP"
     chmod 600 "$TMP"
     mv "$TMP" "$DBURL"
   else
     rm -f "$TMP"
     if [ -s "$DBURL" ]; then
       echo "WARNING: no DATABASE_URL found in the container; keeping the existing $DBURL" >&2
     else
       echo "No DATABASE_URL found anywhere - stop here, do not continue to step 3." >&2
     fi
   fi
```

If the "No DATABASE_URL found anywhere" message appears, do not go past step 1:
there is no database URL to give the new container.

2. **Build the new image from the current checkout:**

```bash
   cd /var/www/events.imsda.org
   docker build -t imsda-events:manual-<short-sha> .
```

   Check the build actually finished (and didn't error) before continuing. The
   build skips the TypeScript check, so also confirm the commit's GitHub CI is
   green before deploying it.

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

   Confirm `status: ok`, the expected `release.sha`, `database`/
   `messageOutbox` both `ok`. After the encryption key has moved to a file, also
   confirm `"encryptionKey":{"configured":true,"source":"file"}` (see "Loading
   the encryption key from a protected file"). Then check `https://events.imsda.org` through
   the real domain (Cloudflare/Nginx), not just the internal `curl`, to
   confirm routing actually reached the new container — and spot-check
   whatever feature the deploy was for.

   Also open one uploaded file — the event badge artwork or a schedule on the
   event page. The `-v imsda_events_assets:...` line above is what attaches the
   uploads volume; a container started without it looks healthy but serves a
   404 for every uploaded file. Nothing is lost: stop it and start it again
   with the volume.

   The container's entrypoint runs the club form sync (`npm run club-forms:sync`)
   right after migrations, so `docker logs` should show
   `Club form templates are in sync.` before `Starting`. If it prints `REFUSED`,
   the container exits: a form version would make a sensitive answer or birth date
   readable again, which needs a reviewed change; roll back below. A large
   re-seal can take minutes before the app answers `/api/health`.

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
```

Keep `/home/u_events/.xcloud/.env.dburl`: the next manual swap reads it, and
the runtime guard accepts it as the home of `DATABASE_URL`.

A `messageOutbox` `failed` count greater than zero in the health check is
usually pre-existing and unrelated to the deploy itself — worth a look in the
admin/ops view separately, but not a reason to roll back.

## Prebuilt images from GitHub (no build on the server)

Building the image on the 4 GB server takes about 40 minutes (`next build`).
`.github/workflows/docker-image.yml` builds it on GitHub after every merge to
`main` (and by hand from the Actions tab) and publishes:

- `ghcr.io/duranttl/imsda-events:<full commit sha>` — deploy this exact tag
- `ghcr.io/duranttl/imsda-events:main` — the latest merge

The image holds no secrets; everything sensitive still comes from the env files
at runtime. A few public values are baked in while Next compiles metadata and
security headers, so set these **repository variables** (Settings → Secrets and
variables → Actions → Variables) to match the server `.env`:
`APP_BASE_URL`, `EMBED_ALLOWED_ORIGINS`, `SQUARE_ENVIRONMENT`,
`SQUARE_ENABLE_PRODUCTION`. Unset ones fall back to
`https://events.imsda.org`, `'self' https://imsda.org https://*.imsda.org`,
`sandbox` and `false`.

To deploy, pull the image for the commit instead of building it, then run the
same rename-and-start steps as the manual rebuild-and-swap (same env files,
volume `imsda_events_assets`, port and networks):

```bash
IMAGE=ghcr.io/duranttl/imsda-events:<full commit sha>
docker pull "$IMAGE"
```

If the pull asks for a login, make the package public once (GitHub → the
repository → Packages → imsda-events → Package settings → Change visibility),
or `docker login ghcr.io` with a token that has `read:packages`.

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
5. Invite colleagues from **Team** in the workspace. Each invitation
   emails its own one-time activation link to the person invited; if they lose it
   they can request another from **Forgot password**. (Where account email is not
   configured — development only, since production requires it — the link is
   shown to you once instead, to pass on yourself.)
6. Confirm `APP_BASE_URL` is the final `https` domain before sending any real links.
7. Confirm the club form templates were synced (#610). `docker-entrypoint.sh`
   runs `npm run club-forms:sync` after `prisma migrate deploy` and before the
   app starts, on every deploy, so there is normally nothing to do; look for
   `Club form templates are in sync.` in the logs. To run it by hand:

   ```bash
   docker compose exec app npm run club-forms:sync
   ```

   It creates missing forms (off), brings changed ones to the code's version, and
   re-seals existing answers for any field that became sensitive, in one
   transaction per form. It is not done by the admin page or by a web request,
   because a large re-seal takes a while. Until it runs, saves to a form whose
   version is behind are refused with "This form is being updated" (nothing is
   written), the admin page shows "Needs sync", and readers and the CSV already
   treat the new code's sensitive keys as restricted. It is safe to run again, and
   it refuses (changing nothing for that form) a version that would make a
   sensitive answer or a birth date readable again; that needs a reviewed change.
   It carries on with the other forms, reports every refusal, and exits non-zero,
   so the container stops and the deploy fails loudly. The app healthcheck
   `start_period` is 300 s so a large re-seal fits before health checks count.

**There is no seed step, and `RUN_DB_SEED` is no longer supported.** `prisma/seed.ts`
writes fictitious events, people, registrations, payments and a refund, and gives
every account one shared password that is published in this repository. It refuses
to run with `NODE_ENV=production` or against any non-loopback database host.

## Event modules release note (#741)

This release adds per-event modules (`EventModule`). The migration backfills a
row for every feature an event already uses, so nothing turns off. A club event
created in the short window between the migration and the new code starting
would have no club-module rows, and its Honors Weekend card would stay hidden
until a system administrator enables the module. After such a deploy, run the
idempotent backfill once from the running app container:

```bash
npm run event-modules:backfill
```

It runs the same `INSERT ... ON CONFLICT DO NOTHING` statements as the
migration (read from the migration file). It only adds missing rows and never
deletes, updates, or turns off a module, so it is safe in production and safe to
repeat. Unlike `event-audience:backfill` it has no `--apply` guard for that
reason.

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

## Loading the encryption key from a protected file (#876)

`SECRET_ENCRYPTION_KEY` protects birth dates, health records, Sterling Volunteers
data and calendar feed addresses. In an env file passed with `--env-file` it is
readable by anyone who can read that file and it appears in `docker inspect`.
Instead, keep it in a root-only file on the server and mount that file into the
container. The app reads it once at startup and trims it.

How the app behaves (`lib/env.ts`):

- `SECRET_ENCRYPTION_KEY_FILE=<path>` makes the app read the key from that file.
- Setting **both** `SECRET_ENCRYPTION_KEY_FILE` and `SECRET_ENCRYPTION_KEY` stops
  startup. Remove the plain variable from the env file.
- A file that is missing, unreadable or empty stops startup, with the variable
  and path named in the log. The key and the file's contents are never logged.
- With only `SECRET_ENCRYPTION_KEY` set, nothing changes (development).
- Everything run inside the app container reads the same variable through the
  same loader: the app, `npm run club-forms:sync` and `lodging:sync` (run by the
  entrypoint), `admin:create`, `admin:reset-mfa` and `key:restore-check`. A shell
  opened with `docker exec` inherits the container's variables, so those commands
  work unchanged. A one-off `docker run` of the image (not `exec`) must be given
  the same `-v` and `-e` pair.
- The **outbox sweeper does not use the key.** It is a `curl` loop that needs only
  `OUTBOX_SWEEP_TOKEN` (`scripts/outbox-sweep.sh`), so it gets no key file. Giving
  it one only widens who can read the key. (The `docker-compose.yml` development
  stack still passes `SECRET_ENCRYPTION_KEY` as a plain variable.)
- `/api/health` reports `"encryptionKey": {"configured": true, "source": "file"}`
  (or `"env"`). `configured: false` with `source: "file"` means the file variable
  is set but the file could not be used. The value is never shown.

**File ownership and mode.** The `Dockerfile` has no `USER` line, so the app
container runs as root (uid 0) and can read a root-owned `0400` file. Keep the
file `root:root` and `0400` on the host. If a `USER` line is ever added to the
`Dockerfile`, a root-owned `0400` file will not be readable inside and startup
will fail with "not readable by this process"; change the host file to that
user's uid (`chown <uid>:<uid> /etc/imsda/secret-encryption-key`, mode stays
`0400`), because a bind mount keeps the host's numeric owner. Check with
`docker exec <app> id`.

### One-time steps on the production server (a system administrator does these)

Run as root over SSH. Do not paste the key into chat, a ticket or a shell
history that is shared.

1. Create the file from the key the **running** container actually uses, so the
   copy is byte-for-byte what the app has today (an env file's quoting or
   whitespace can differ from what the app sees), with nothing printed:

```bash
install -d -m 0700 -o root -g root /etc/imsda
( umask 077; docker exec xcloud-site-<id>-app-1 printenv SECRET_ENCRYPTION_KEY | tr -d '\n' > /etc/imsda/secret-encryption-key )
chown root:root /etc/imsda/secret-encryption-key
chmod 0400 /etc/imsda/secret-encryption-key
ls -l /etc/imsda/secret-encryption-key      # expect: -r-------- 1 root root, size not 0
```

   Compare checksums (a hash, not the key). The two lines must be identical:

```bash
sha256sum < /etc/imsda/secret-encryption-key
docker exec xcloud-site-<id>-app-1 printenv SECRET_ENCRYPTION_KEY | tr -d '\n' | sha256sum
```

   If they differ, or the first file is empty, stop: do not continue and never
   generate a new key here, or every sealed value becomes unreadable.

2. Make the two backup copies of the key now (next section), **before** changing
   the running container.

3. Add the mount and variable to `/root/manual-deploy.sh`, on the app container's
   `docker run`, next to the other `-v` and `-e` lines. Use `--mount`, not `-v`:
   with `-v`, Docker silently creates a **directory** at a missing host path, and
   the app then refuses to start (both variables set, or an unreadable key).
   `--mount type=bind` fails the `docker run` with an error instead.

```bash
     --mount type=bind,source=/etc/imsda/secret-encryption-key,target=/run/secrets/encryption-key,readonly \
     -e SECRET_ENCRYPTION_KEY_FILE=/run/secrets/encryption-key \
```

   Do this only after step 1 has produced the file, and do the deploy (step 5)
   right after step 4. Deploying with the key already removed from the env file
   but no mount, or with the mount but the key still in the env file, leaves the
   app unable to start.

   The `imsda-outbox-sweeper` container needs no change (see above).

   **If the site is deployed through the xCloud Compose path** (the
   `docker-compose.env.yml` override and `scripts/xcloud-post-deploy.sh` /
   the runtime guard, "Permanent xCloud Dockerfile-only runtime override" above),
   that path recreates the app with only `.env` and `.env.dburl`, so the same
   mount has to go into the `app` service in
   `/home/u_events/.xcloud/docker-compose.env.yml`. **Do not add it ahead of time:**
   with the key still in `.env` and the file variable in the override, an xCloud
   recreate in between would start the app with both and it would refuse to start.
   Make this edit and the `.env` removal in step 4 together, with the guard paused
   (see "Compose path" under step 4):

```yaml
services:
  app:
    environment:
      SECRET_ENCRYPTION_KEY_FILE: /run/secrets/encryption-key
    volumes:
      - type: bind
        source: /etc/imsda/secret-encryption-key
        target: /run/secrets/encryption-key
        read_only: true
        bind:
          create_host_path: false   # fail if the file is missing; never create a directory
```

   (Merge this into the existing `app:` entry; keep its `env_file`, `APP_RELEASE_SHA`
   and `networks`.) The guard (`scripts/xcloud-post-deploy.sh`) refuses to recreate
   the app when the key is gone from `.env` and the override has no
   `SECRET_ENCRYPTION_KEY_FILE`, and also when **both** are present ("finish the
   move"). It fails a recreated container that has neither key variable and warns
   when a running container has neither. Blank and commented-out lines do not
   count as a key. It checks variable names only, never values.

4. Remove the key line from the env file, keeping a private copy of the old file
   until the deploy is confirmed:

```bash
cp -p /home/u_events/.xcloud/.env /root/env.before-876.bak     # contains the key; delete after step 6
sed -i '/^SECRET_ENCRYPTION_KEY=/d' /home/u_events/.xcloud/.env
grep -c '^SECRET_ENCRYPTION_KEY' /home/u_events/.xcloud/.env   # expect 0
```

   Also remove the variable from the hosting panel if it is stored there, or the
   container will have both and refuse to start.

   **Compose path (xCloud override).** Do the override edit from step 3 and the
   `.env` removal above as one change, with automatic redeploys stopped so nothing
   recreates the app halfway:

```bash
systemctl stop imsda-xcloud-runtime-guard.timer      # if the server-level guard is installed
# Also do not trigger an xCloud deploy until this block is finished.
cp -p /home/u_events/.xcloud/docker-compose.env.yml /root/docker-compose.env.before-876.bak
# 1. edit docker-compose.env.yml: add the environment + bind volume from step 3
# 2. remove the key line from .env (the cp / sed lines above)
docker compose -f /home/u_events/.xcloud/docker-compose.yml -f /home/u_events/.xcloud/docker-compose.env.yml config --quiet && echo config-ok
docker compose -f /home/u_events/.xcloud/docker-compose.yml -f /home/u_events/.xcloud/docker-compose.env.yml up -d --force-recreate app
systemctl start imsda-xcloud-runtime-guard.timer
```

   Then do step 6 (the `docker inspect` line there uses the compose container's
   name from `docker ps`). If the app does not come up healthy, roll back: stop the
   timer again, `cp -p /root/docker-compose.env.before-876.bak
   /home/u_events/.xcloud/docker-compose.env.yml`, restore the key line in `.env`
   from `/root/env.before-876.bak`, run the same `up -d --force-recreate app`
   command, and start the timer. The `--mount`-style failure for a missing file
   shows up here, in the `up` output, rather than as a restart loop.

5. Manual-deploy path: deploy with `/root/manual-deploy.sh` as usual (the rollback steps above still
   apply; the `-old` container still has the key in its own environment, so
   remove it once the new one is confirmed).

6. Confirm:

```bash
curl -s http://127.0.0.1:8100/api/health | grep -o '"encryptionKey":{[^}]*}'
# expect: "encryptionKey":{"configured":true,"source":"file"}
docker inspect xcloud-site-<id>-app-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^SECRET_ENCRYPTION_KEY='
# expect 0 (only SECRET_ENCRYPTION_KEY_FILE, a path, is listed)
```

   Then sign in as an administrator with MFA: that opens a sealed value, which is
   the real proof the file holds the right key. Once confirmed, delete
   `/root/env.before-876.bak` and the `-old` container.

7. Rollback: the `-old` container still has the key in its own environment and
   works unchanged, so the usual rename-back is enough. Rolling back to an
   **image built before this change** by starting a new container is different:
   older images do not know `SECRET_ENCRYPTION_KEY_FILE`, so put the
   `SECRET_ENCRYPTION_KEY=` line back in `/home/u_events/.xcloud/.env` first (from
   the file, or `/root/env.before-876.bak` if it still exists) and drop the
   `--mount` and `SECRET_ENCRYPTION_KEY_FILE` lines for that run. Move forward
   again with the steps above.

### Keeping and testing the key backup

The file on the server is not a backup. Losing it loses every sealed value for
good.

- Keep **two offline copies**: one entry in the conference password manager, and
  one sealed, printed copy held by the key custodian (not kept at the server).
- **Never** store the key with the database backups (`imsda_events_backups`, the
  off-host copy, #875) or in the same place as anything that can read them. The
  key and the dumps together open everything; apart, neither does.
- When the key is rotated, replace both copies and test again.

**Restore test (once before health records go live, then after any change to the
key or the backup process).** It restores a dump into a scratch database and opens
one sealed value using the *backup copy* of the key, not the server's file. Never
run it against the live database.

1. Fetch the key from the password manager onto the server into a temporary file
   readable only by root, outside the backup volume:

```bash
install -d -m 0700 /root/keytest
umask 077
vi /root/keytest/backup-key      # paste the key from the password manager; save
chmod 0400 /root/keytest/backup-key
```

2. Restore last night's dump into a scratch database and keep it. In the backup
   container (compose) or anywhere with `pg_restore` and the dump:

```bash
docker compose exec -e RESTORE_KEEP_SCRATCH=true -e RESTORE_SCRATCH_DB=imsda_events_keytest_restore_check \
  backup sh /usr/local/bin/pg-restore-verify.sh
```

   Check it ends with `restore rehearsal succeeded` and non-zero row counts (a
   failed rehearsal always drops its scratch database; a successful one prints
   the command to drop it). If
   this server's backups are not made by the compose `backup` service, create the
   scratch database by hand (`createdb imsda_events_keytest_restore_check`) and restore
   the dump into it with `pg_restore --no-owner --no-privileges --exit-on-error
   --dbname=imsda_events_keytest_restore_check <dump>`; the next step is the same.

3. Run the key check from a one-off container of the app image, using the backup
   key and the scratch database. Build a temporary owner-only env file from
   `.env.dburl` with the database name changed (the password never appears on a
   command line or in `docker inspect`):

```bash
( umask 077; sed -E 's#^(DATABASE_URL=postgres(ql)?://[^/]+/)[^?]*#\1imsda_events_keytest_restore_check#' \
    /home/u_events/.xcloud/.env.dburl > /root/keytest/db.env )
grep -c 'imsda_events_keytest_restore_check' /root/keytest/db.env     # expect 1

docker run --rm \
  --network postgresql_9kgaw_239292_xcloud-network \
  --env-file /root/keytest/db.env \
  --mount type=bind,source=/root/keytest/backup-key,target=/run/secrets/encryption-key,readonly \
  -e SECRET_ENCRYPTION_KEY_FILE=/run/secrets/encryption-key \
  --entrypoint npm imsda-events:manual-<short-sha> run key:restore-check
```

   The check refuses any database whose name is not `restore_check` or does not
   end in `_restore_check`. It needs only the key and `DATABASE_URL`, not the
   other production secrets.

   Expected: `canary seal and open: ok`, then `opened one sealed value from the
   restored database: ok`, then `PASSED`. The output never contains the key or any
   value. `FAILED: ... could NOT open` means the backup key is not the key that
   sealed that data: stop and find the right key before anything else. To test
   the key alone, add `-- --canary-only` (no database needed).

4. Clean up, then record the date:

```bash
docker compose exec backup psql --dbname=postgres -c 'DROP DATABASE IF EXISTS imsda_events_keytest_restore_check;'
shred -u /root/keytest/backup-key /root/keytest/db.env && rmdir /root/keytest
```

   Record the date and result in the log in `docs/SERVER-SECURITY-CHECKLIST.md`
   (item 3). The System readiness page (#870) does not exist yet; when it does,
   it will show the key status (configured, and loaded from a file or the
   environment) and the date of the last restore test, and this date goes there
   too.

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
npm run db:deploy
npm run db:seed
npm run club-forms:sync
npm run dev
```

`club-forms:sync` creates the club form templates (off) and brings them to the
code's version; run it once after `db:seed`, and again after pulling a change to
`modules/club-forms/definitions.ts`. Until it has run, the Club forms admin page
shows "Needs sync" and no form can be turned on.
