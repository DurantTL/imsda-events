# Deploying with Docker (xCloud "Deploy Any App From Git" and similar)

The repository ships a production `Dockerfile` and a `docker-compose.yml` that runs
the whole stack — the Next.js app **and** its PostgreSQL database — with one command:

```bash
docker compose up -d --build
```

What happens on `docker compose up`:

1. **postgres** starts (PostgreSQL 16) and becomes healthy.
2. **app** builds from the `Dockerfile`, waits for postgres to be healthy, then its
   entrypoint runs `prisma migrate deploy` (and `prisma db seed` if `RUN_DB_SEED=true`)
   before starting `next start` on port 3000.

The reverse proxy (xCloud's Nginx) forwards your domain to the app's published port.

## Why the port collision can't happen here (the "port is already allocated" error)

Postgres is reached by the app **internally** as host `postgres`, so `docker-compose.yml`
publishes **no host port for the database at all**. That means it can never collide with
another Postgres already using `5432` on the host (a common shared-server situation).
Local development, which needs host access to the database, layers in
`docker-compose.dev.yml` to publish `5432` — deploy hosts never load that file.

The **app** does publish a web port for the reverse proxy. If `3000` is already taken on
the host, set `APP_PORT` to a free port and point the proxy at that.

## Environment variables (set these in the xCloud env panel)

Only `KEY=value` lines — no comments, no blank lines, no spaces in values.

**Required for production:**

```
APP_BASE_URL=https://your-final-domain
MANAGE_LINK_DERIVATION_SECRET=<openssl rand -base64 48>
ATTENDEE_PASS_SIGNING_SECRET=<openssl rand -base64 48>
RATE_LIMIT_HASH_SECRET=<openssl rand -base64 48>
```

`NODE_ENV`, `DATABASE_URL`, and the internal Postgres wiring are already set by
`docker-compose.yml` — you do **not** provide `DATABASE_URL` here.

**First deploy only** — load the fictitious starter data (admin login + demo event),
then remove it so later restarts don't re-seed:

```
RUN_DB_SEED=true
```

**Optional / conditional:**

```
APP_PORT=3100                    # only if host 3000 is already in use
POSTGRES_PASSWORD=<strong>       # overrides the default dev password
RATE_LIMIT_TRUSTED_PROXY_HOPS=1  # 1 for a single Nginx; 2 if Cloudflare is also in front
RATE_LIMIT_CLIENT_IP_HEADER=x-forwarded-for   # cf-connecting-ip behind Cloudflare
```

(There is no `POSTGRES_HOST_PORT` to set for deployment — the database is not published
to the host at all. That variable only matters for the local `docker-compose.dev.yml` overlay.)

Email (Resend) and Square are left disabled unless you supply their credentials;
Square stays in Sandbox until `SQUARE_ENVIRONMENT=production` **and**
`SQUARE_ENABLE_PRODUCTION=true` are both set. See the main README for those.

## First-deploy checklist

1. Set the required env vars above, plus `RUN_DB_SEED=true`.
2. Deploy. Watch the logs for `Applying database migrations...` then the seed, then
   `Starting`.
3. Visit the app; `GET /api/health` should return `{"status":"ok"}`. Sign in with the
   seeded `admin@imsda-events.test` account (password in the README).
4. Remove `RUN_DB_SEED` (or set it to `false`) so future restarts don't re-seed.
5. Before sending any real links, confirm `APP_BASE_URL` is the final `https` domain.

## Default local development is unchanged

For local work you still run only the database and the dev server on the host:

```bash
docker compose up -d postgres
npm run dev
```
