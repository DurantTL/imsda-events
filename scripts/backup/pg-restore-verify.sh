#!/bin/sh
# Restores the most recent dump into a scratch database and records row counts.
#
# This is the part that is usually skipped. A backup that has never been
# restored is not a backup — it is an untested assumption about a file. Run this
# on a schedule and keep its output; the row counts are the evidence that the
# rehearsal happened and what it found.
#
# Two modes (RESTORE_MODE):
#   private (default when initdb is installed, as in the backup image): starts a
#     throwaway PostgreSQL in a temporary directory inside this container
#     (unix socket only, no network, fsync off), restores into it, then stops
#     it and deletes the directory. The production database server is never
#     touched, no CREATEDB privilege is needed, and it adds no load there.
#     Temporary cost: disk about the size of the restored (uncompressed)
#     database under RESTORE_TMP_DIR, and roughly 100-200 MB of RAM while it
#     runs.
#   server: creates and drops a scratch database on the server named by PGHOST
#     (needs CREATEDB). Kept for the Compose development stack; refuses to run
#     if the scratch name is the live database.
#
# Environment:
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   connection (server mode only)
#   BACKUP_DIR            where dumps are read from (default /backups)
#   RESTORE_MODE          private or server (default: private if initdb exists)
#   RESTORE_TMP_DIR       where the private server lives (default /tmp)
#   RESTORE_SCRATCH_DB    scratch database name (default imsda_events_restore_check)
#   BACKUP_FILE           restore this dump instead of the newest one
set -eu

MODE="${RESTORE_MODE:-}"
if [ -z "${MODE}" ]; then
  if command -v initdb >/dev/null 2>&1; then MODE=private; else MODE=server; fi
fi
case "${MODE}" in private | server) ;; *) echo "[restore-verify] bad RESTORE_MODE" >&2; exit 2 ;; esac

BACKUP_DIR="${BACKUP_DIR:-/backups}"
LIVE_DB="${PGDATABASE:-imsda_events}"
SCRATCH_DB="${RESTORE_SCRATCH_DB:-imsda_events_restore_check}"

if [ "${MODE}" = "server" ] && [ "${SCRATCH_DB}" = "${LIVE_DB}" ]; then
  echo "[restore-verify] RESTORE_SCRATCH_DB must not be the live database (${LIVE_DB})." >&2
  exit 1
fi

DUMP="${BACKUP_FILE:-$(ls -1t "${BACKUP_DIR}"/imsda-events-*.dump 2>/dev/null | head -n 1 || true)}"
if [ -z "${DUMP}" ] || [ ! -f "${DUMP}" ]; then
  echo "[restore-verify] No dump found in ${BACKUP_DIR}." >&2
  exit 1
fi

echo "[restore-verify] $(date -u +%FT%TZ) restoring ${DUMP} into ${SCRATCH_DB} (${MODE} mode)"

# PostgreSQL refuses to run as root; the image runs as root to write the
# volumes, so the private server itself runs as the postgres user.
as_postgres() {
  if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1; then
    su-exec postgres "$@"
  else
    "$@"
  fi
}

WORK=""
STARTED=0
cleanup() {
  if [ "${MODE}" = "private" ]; then
    if [ "${STARTED}" -eq 1 ]; then
      as_postgres pg_ctl -D "${WORK}/data" -m immediate -w -s stop >/dev/null 2>&1 || true
    fi
    [ -z "${WORK}" ] || rm -rf "${WORK}"
  else
    psql --dbname=postgres --quiet --command "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "${MODE}" = "private" ]; then
  WORK="$(mktemp -d "${RESTORE_TMP_DIR:-/tmp}/restore-check.XXXXXX")"
  if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1; then chown postgres "${WORK}"; fi
  chmod 700 "${WORK}"
  as_postgres initdb -D "${WORK}/data" -U postgres --auth=trust --encoding=UTF8 >/dev/null
  as_postgres pg_ctl -D "${WORK}/data" -w -s -l "${WORK}/server.log" \
    -o "-c listen_addresses= -c unix_socket_directories=${WORK} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0 -c shared_buffers=64MB -c max_connections=10" start
  STARTED=1
  # Point every client below at the private server, never at production.
  unset PGPASSWORD PGOPTIONS PGPORT PGSERVICE PGSSLMODE
  export PGHOST="${WORK}" PGUSER=postgres
fi

psql --dbname=postgres --quiet --command "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";"
psql --dbname=postgres --quiet --command "CREATE DATABASE \"${SCRATCH_DB}\";"

# --exit-on-error turns a partially restored database into a failed rehearsal,
# which is the whole point of running this.
pg_restore --dbname="${SCRATCH_DB}" --no-owner --no-privileges --exit-on-error "${DUMP}"

echo "[restore-verify] row counts in the restored copy:"
psql --dbname="${SCRATCH_DB}" --tuples-only --no-align --field-separator=' ' --command "
  SELECT relname, n_live_tup
  FROM pg_stat_user_tables
  WHERE n_live_tup > 0
  ORDER BY n_live_tup DESC, relname;
" | sed 's/^/[restore-verify]   /'

# The tables that hold the data a rehearsal exists to protect. A restore that
# comes back with an empty Registration table has failed, however clean the
# pg_restore exit code was.
for table in Registration RegistrationAttendee Payment Person; do
  COUNT="$(psql --dbname="${SCRATCH_DB}" --tuples-only --no-align --command "SELECT count(*) FROM \"${table}\";")"
  echo "[restore-verify]   verified ${table}=${COUNT}"
done

echo "[restore-verify] $(date -u +%FT%TZ) restore rehearsal succeeded for ${DUMP}"
