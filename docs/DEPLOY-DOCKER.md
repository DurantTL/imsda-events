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
4. **backup** takes a nightly `pg_dump` and periodically rehearses a restore.

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

Only `KEY=value` lines — no comments, no blank lines, no spaces in values.

**Required for production** — the app will not start without all of these:

```
APP_BASE_URL=https://your-final-domain
POSTGRES_PASSWORD=<strong>
MANAGE_LINK_DERIVATION_SECRET=<openssl rand -base64 48>
ATTENDEE_PASS_SIGNING_SECRET=<openssl rand -base64 48>
RATE_LIMIT_HASH_SECRET=<openssl rand -base64 48>
OUTBOX_SWEEP_TOKEN=<openssl rand -base64 48>
```

Each secret needs at least 32 characters. If one is missing or malformed the
container exits at startup with the offending variable named in its log, rather
than serving pages and failing later on a QR pass or a private link.

`NODE_ENV` and `DATABASE_URL` are set by `docker-compose.yml` — you do **not**
provide `DATABASE_URL` here.

**Optional / conditional:**

```
APP_PORT=3100                    # only if host 3100 is already in use
RATE_LIMIT_TRUSTED_PROXY_HOPS=1  # 1 for a single Nginx; 2 if Cloudflare is also in front
RATE_LIMIT_CLIENT_IP_HEADER=x-forwarded-for   # cf-connecting-ip behind Cloudflare
OUTBOX_SWEEP_INTERVAL_SECONDS=300
BACKUP_RETENTION_DAYS=14
BACKUP_VERIFY_EVERY=7            # rehearse a restore every Nth backup
BACKUP_OFFSITE_COMMAND=          # receives the dump path as $1
```

(There is no `POSTGRES_HOST_PORT` to set for deployment — the database is not published
to the host at all. That variable only matters for the local `docker-compose.dev.yml` overlay.)

Email (Resend) and Square are left disabled unless you supply their credentials;
Square stays in Sandbox until `SQUARE_ENVIRONMENT=production` **and**
`SQUARE_ENABLE_PRODUCTION=true` are both set. See the main README for those.

## First-deploy checklist

1. Set the required env vars above.
2. Deploy. Watch the logs for `Applying database migrations...` then `Starting`.
   A startup failure names the environment variable that caused it.
3. `GET /api/health` should return `{"status":"ok"}` with `database` and
   `messageOutbox` both `ok`.
4. Create the first real administrator. The database starts empty and there is no
   first-run setup screen, so this is the supported way in:

   ```bash
   docker compose exec app npm run admin:create -- \
     --email you@imsda.org --name "Your Name"
   ```

   It prints a one-time activation URL. Open it and choose a password. The link is
   shown once — only its digest is stored — and expires after seven days. The
   account cannot sign in until it is activated.
5. Invite colleagues from **Staff access** in the workspace. Each invitation
   produces its own one-time activation link, shown once to you. Recovery email is
   not connected yet, so pass the link on yourself.
6. Confirm `APP_BASE_URL` is the final `https` domain before sending any real links.

**There is no seed step, and `RUN_DB_SEED` is no longer supported.** `prisma/seed.ts`
writes fictitious events, people, registrations, payments and a refund, and gives
every account one shared password that is published in this repository. It refuses
to run with `NODE_ENV=production` or against any non-loopback database host.

## Backups and restore rehearsals

The `backup` service writes `pg_dump` custom-format dumps to the
`imsda_events_backups` volume, prunes anything older than `BACKUP_RETENTION_DAYS`,
and every `BACKUP_VERIFY_EVERY` runs restores the newest dump into a scratch
database and prints its row counts.

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

## Default local development is unchanged

For local work you still run only the database and the dev server on the host:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
npm run dev
```
