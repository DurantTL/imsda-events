# Backups: nightly dumps to Cloudflare R2, with status in the app

This is the production runbook for the manually started deployment
(`/root/manual-deploy.sh`, image `ghcr.io/duranttl/imsda-events:<sha>`, Postgres
in its own container). The Compose `backup` service described in
`DEPLOY-DOCKER.md` runs the same scripts for the all-in-one stack.

## What runs

A small second container, **`imsda-backup`**, started next to the app and the
`imsda-outbox-sweeper`. Every 24 hours it:

1. `pg-backup.sh`: `pg_dump` (custom format) to the local `imsda_events_backups`
   volume, then copies the dump to R2.
2. `assets-backup.sh`: archives the `imsda_events_assets` volume (mounted
   **read-only**), checks the archive reads back, then copies it to R2.
3. Deletes local files older than `BACKUP_RETENTION_DAYS` (14).
4. `record-status.sh`: writes one status row (see below).
5. Every 7th run (`BACKUP_VERIFY_EVERY`, starting with the first), runs
   `pg-restore-verify.sh`: restores the newest local dump into a scratch
   database, checks row counts, drops the scratch database, and records the
   result.

A failed off-site copy never stops the local backup, and a failed backup or
rehearsal never stops the next night's run; both are recorded and logged.

### Why a small dedicated image

The scheduler needs `pg_dump` 16 (it refuses to dump a server newer than
itself), an S3 client for R2, and the scripts. The production server has no
checkout of this repository (the app image is built by GitHub), so mounting the
scripts from the repo is not possible without adding a manual copy step that
drifts. `scripts/backup/Dockerfile` builds `postgres:16-alpine` + `aws-cli` +
the scripts, and the existing image workflow publishes it as
`ghcr.io/duranttl/imsda-events-backup:<sha>` on every merge to `main`, so it is
versioned and rolled back exactly like the app. It holds no secrets.

## Where the status goes

A table, `BackupRun` (additive migration `20261014100000_backup_run`). The
scheduler writes it with `psql` using the same database connection settings the
dumps use; the app reads it with Prisma. A table was chosen over a status file
because the backup container and the app share no volume (the app only mounts
the assets volume, and giving it a writable shared path is an extra moving part
and an extra thing to forget), while both already reach the database. It is
also queryable and keeps history.

Each row: `kind` (`BACKUP` or `REHEARSAL`), `startedAt`, `finishedAt`, `ok`,
`dumpBytes`, `assetsBytes`, `offsiteOk` (null when no off-site copy is
configured). No file names, paths, row contents or credentials.

`/api/health` shows it as a `backups` block (and `services.backups`):

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `failing` (latest run failed, a success is still recent), `stale`, `never` (nothing recorded yet) |
| `stale` | `true` after 36 hours without a successful backup |
| `lastSuccessAt`, `lastRunAt`, `lastRunOk` | newest successful / newest run |
| `dumpBytes`, `assetsBytes` | sizes from the last successful run |
| `offsiteOk`, `lastOffsiteSuccessAt` | latest run's off-site result / last time it worked |
| `lastRehearsalAt`, `lastRehearsalOk` | latest restore rehearsal |

Health status rules: a stale or failing backup, a failed off-site copy, or a
failed rehearsal makes `status` **`degraded`**, still HTTP 200. Only a database
failure returns 503, so a missing backup never takes the app out of rotation.
`never` does not degrade (a fresh deployment is not unhealthy before its first
night), so the verification step below must be done by a person. The System
readiness page (#870) will show the same block once it exists.

## One-time human steps

### 1. Create the R2 bucket and a bucket-scoped token

In the Cloudflare dashboard, under R2:

1. Create a bucket (for example `imsda-events-backups`). Keep it private; do
   not enable public access or a custom domain.
2. **R2 > Manage API tokens > Create API token.** Permission **Object Read &
   Write**, **Specify bucket** and pick only this bucket. (Do not use an
   account-wide token.) Copy the Access Key ID and Secret Access Key now; the
   secret is shown once. The account id is on the R2 overview page.
3. **Lifecycle rule** on the bucket: delete objects after N days. 90 days is
   suggested; **a human decides the number**. Local copies are separate (14
   days). Set the rule on prefix `imsda-events/` if the bucket is shared.

Use a token for backups only. The encryption key does **not** go in this
bucket or under this token (see below).

### 2. Create the server env file

`/home/u_events/.xcloud/.env.backup`, mode `600`, owned by the deploy user.
This is the only place the secrets live; never commit it or paste it in chat.

```
# Database connection for pg_dump / psql (use a role that can read every table,
# insert into "BackupRun", and CREATE DATABASE for the rehearsal; the app's own
# role works if it owns the database).
PGHOST=postgresql-postgresql_9kgaw_239292
PGPORT=5432
PGUSER=<database user>
PGPASSWORD=<database password>
PGDATABASE=<database name>

# Cloudflare R2 (S3 API at https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com)
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=<bucket-scoped token access key id>
R2_SECRET_ACCESS_KEY=<bucket-scoped token secret>
R2_BUCKET=<bucket name>
# R2_PREFIX=imsda-events        # optional key prefix, this is the default

BACKUP_RETENTION_DAYS=14        # human approves
BACKUP_VERIFY_EVERY=7
```

Use separate plain `KEY=value` lines (no quotes, no `export`), as for `docker
--env-file`. `PGDATABASE`/`PGUSER`/`PGPASSWORD` are the pieces of the app's
`DATABASE_URL` (a URL with `?schema=` cannot be given to `psql` directly). The
default off-site command (`offsite-r2.sh`) is baked into the image and reads the
`R2_*` names above; do not set `BACKUP_OFFSITE_COMMAND` unless you are
replacing it.

Check the server's Postgres major version matches the image's client (16):
`docker exec postgresql-postgresql_9kgaw_239292 postgres --version`.

### 3. Start the container

The image is published as `ghcr.io/duranttl/imsda-events-backup:<sha>` by the
Docker image workflow (same sha as the app image you deployed; it is also
tagged `:main`).

**One-time, owner only: make the package pullable.** GitHub creates a new
container package as **private**. It contains no secrets (only PostgreSQL
client tools, the AWS CLI and these scripts), so either set it public, as was
done for the app image, or log in on the server.

*Option A, make it public (matches the app image):*

1. On GitHub, open the `DurantTL` profile (or the owning organisation), then the
   **Packages** tab, then **imsda-events-backup**. It appears after the first
   successful run of the "Docker image" workflow on `main`.
2. Click **Package settings** (right-hand sidebar).
3. Scroll to **Danger Zone**, click **Change visibility**, choose **Public**,
   type the package name to confirm, and click **I understand the consequences,
   change package visibility**.

*Option B, keep it private:* in the same **Package settings**, under **Manage
Actions access** or **Invite teams or people**, make sure the repository/account
used on the server has Read access, then on the server run
`docker login ghcr.io -u <github user>` with a personal access token that has
`read:packages`.

```bash
SHA=<commit sha>
docker pull ghcr.io/duranttl/imsda-events-backup:$SHA
docker volume create imsda_events_backups

docker rm -f imsda-backup 2>/dev/null
docker run -d --name imsda-backup --restart unless-stopped \
  --network postgresql_9kgaw_239292_xcloud-network \
  --env-file /home/u_events/.xcloud/.env.backup \
  -v imsda_events_assets:/assets:ro \
  -v imsda_events_backups:/backups \
  ghcr.io/duranttl/imsda-events-backup:$SHA
```

The migration that creates `BackupRun` must be applied before the first run
completes (it is part of the normal app deploy). Add the same `docker run`
to `/root/manual-deploy.sh` beside the sweeper so a redeploy keeps it running.
Upgrading the backup image is the same two lines with a new `$SHA`; the
volume (and its history) is untouched.

To run a backup right now instead of waiting a day, start a one-off container
with the same options plus `-e BACKUP_RUN_ONCE=1` and `--rm` (omit `-d`).

### 4. Verify

```bash
docker logs imsda-backup 2>&1 | tail -30
```

Expect `[backup] wrote ...`, `[offsite-r2] uploaded imsda-events/imsda-events-<stamp>.dump`,
`[asset-backup] ...`, then `restore rehearsal succeeded`. Then:

1. `curl -s https://<app host>/api/health` and check
   `backups.lastSuccessAt`, `backups.offsiteOk: true`, and
   `backups.lastRehearsalOk: true`. (`backups.status` of `never` means the
   container is not running, cannot reach the database, or the migration has not
   been applied: look at `docker logs imsda-backup` for `could not record
   status`.)
2. In the Cloudflare dashboard, confirm both the `.dump` and `.tar.gz` objects
   are in the bucket under `imsda-events/`.
3. Confirm the lifecycle rule is saved.

## Weekly rehearsal

The scheduler restores the newest local dump into a scratch database
(`imsda_events_restore_check`, dropped afterwards, never the live database) every
7th run and records the result. Weekly, a human:

1. Reads `/api/health`: `backups.lastRehearsalOk` is `true` and
   `lastRehearsalAt` is within about 8 days.
2. `docker logs imsda-backup 2>&1 | grep restore-verify` shows row counts for
   `Registration`, `RegistrationAttendee`, `Payment` and `Person` that look
   plausible.
3. Once a quarter, restore from **R2** (not the local copy) using the steps below
   on a scratch database, to prove the off-site files themselves are usable.

## Restoring from R2

Do this only for a real recovery or a drill on a scratch database. Restoring
over production is a human decision.

```bash
# Fetch the files into a scratch folder on the server (uses the same env file).
mkdir -p /root/restore && cd /root/restore
docker run --rm --env-file /home/u_events/.xcloud/.env.backup \
  -v /root/restore:/restore --entrypoint sh \
  ghcr.io/duranttl/imsda-events-backup:main -c '
    export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
    EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
    aws s3 ls "s3://$R2_BUCKET/${R2_PREFIX:-imsda-events}/" --endpoint-url "$EP"
    aws s3 cp "s3://$R2_BUCKET/${R2_PREFIX:-imsda-events}/imsda-events-<stamp>.dump" /restore/ --endpoint-url "$EP"
    aws s3 cp "s3://$R2_BUCKET/${R2_PREFIX:-imsda-events}/imsda-assets-<stamp>.tar.gz" /restore/ --endpoint-url "$EP"'
```

Pick a database dump and an assets archive from the same night. Then, with the
app stopped:

```bash
docker stop <app container> imsda-outbox-sweeper
# Database (into the live database; for a drill, create a scratch database and
# change --dbname instead):
docker run --rm --env-file /home/u_events/.xcloud/.env.backup \
  --network postgresql_9kgaw_239292_xcloud-network \
  -v /root/restore:/restore:ro --entrypoint sh \
  ghcr.io/duranttl/imsda-events-backup:main -c \
  'pg_restore --dbname="$PGDATABASE" --clean --if-exists --no-owner --no-privileges /restore/imsda-events-<stamp>.dump'
# Uploaded files:
docker run --rm -v imsda_events_assets:/assets -v /root/restore:/restore:ro \
  --entrypoint sh ghcr.io/duranttl/imsda-events-backup:main -c \
  'find /assets -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /restore/imsda-assets-<stamp>.tar.gz -C /assets'
```

Restart the app and sweeper, then check `/api/health` and a few registrations.
Delete `/root/restore` afterwards; it holds personal data.

Encrypted fields in the restored data can only be read with the original
`SECRET_ENCRYPTION_KEY` (below).

## The encryption key is backed up separately

`SECRET_ENCRYPTION_KEY` is **not** included in these backups, is **never**
uploaded to this R2 bucket, and must not share its credentials. The dumps hold
the encrypted values; without the key they cannot be read, and with the key in
the same place as the dumps the encryption would protect nothing. Its backup
and one-time test restore are tracked separately in #876. Until that exists,
these backups are not a complete recovery.

## Secrets and logs

R2 and database credentials exist only in `/home/u_events/.xcloud/.env.backup`.
They are not in the repository, the image, or the scripts' output
(`offsite-r2.sh` prints the file name, bucket and prefix, never the keys; status
rows hold times, sizes and flags). Rotate the R2 token in Cloudflare and edit the
env file, then `docker restart imsda-backup`.
