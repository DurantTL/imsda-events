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
#   RESTORE_HEADROOM_MB   free space required beyond 6x the dump (default 512)
#   REHEARSAL_ALLOW_EMPTY true to accept empty Registration/Person (development)
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
# volumes, so the private server itself runs as the postgres user (gosu, or
# su-exec as a fallback). Root with neither available is an error, not a
# silent attempt that fails obscurely.
RUN_AS=""
if [ "${MODE}" = "private" ] && [ "$(id -u)" = "0" ]; then
  if command -v gosu >/dev/null 2>&1; then
    RUN_AS="gosu postgres"
  elif command -v su-exec >/dev/null 2>&1; then
    RUN_AS="su-exec postgres"
  else
    echo "[restore-verify] running as root but neither gosu nor su-exec exists to drop to the postgres user." >&2
    exit 1
  fi
fi
# shellcheck disable=SC2086
as_postgres() { ${RUN_AS} "$@"; }

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
# A stopped container sends TERM; exit so the EXIT trap still cleans up.
trap 'exit 143' INT TERM

if [ "${MODE}" = "private" ]; then
  TMP_BASE="${RESTORE_TMP_DIR:-/tmp}"
  mkdir -p "${TMP_BASE}"
  # Leftovers from a run that was killed before it could clean up.
  rm -rf "${TMP_BASE}"/restore-check.*

  # The private server holds the whole restored database (uncompressed, plus
  # indexes and WAL), so refuse clearly rather than fill a disk that other
  # things, such as the backup volume itself, may share.
  DUMP_BYTES="$(wc -c < "${DUMP}")"
  NEED_KB=$((DUMP_BYTES * 6 / 1024 + ${RESTORE_HEADROOM_MB:-512} * 1024))
  AVAIL_KB="$(df -Pk "${TMP_BASE}" | awk 'NR==2 {print $4}')"
  if [ -n "${AVAIL_KB}" ] && [ "${AVAIL_KB}" -lt "${NEED_KB}" ]; then
    echo "[restore-verify] only ${AVAIL_KB} KB free in ${TMP_BASE}; need about ${NEED_KB} KB (6x the dump plus headroom). Free space or set RESTORE_TMP_DIR." >&2
    exit 1
  fi

  WORK="$(mktemp -d "${TMP_BASE}/restore-check.XXXXXX")"
  if [ -n "${RUN_AS}" ]; then chown postgres "${WORK}"; fi
  chmod 700 "${WORK}"

  # Keep only the search_path (for a non-public Prisma schema), then scrub every
  # PG* variable so nothing about the production connection (host, hostaddr,
  # port, service, password file, ...) can reach the private server or its
  # clients. This happens before initdb and pg_ctl.
  SAVED_SEARCH_PATH="$(printf '%s' "${PGOPTIONS:-}" | grep -o -E -e '-c[ =]?search_path=[^ ]+' | head -n 1 || true)"
  for name in $(env | sed -n 's/^\(PG[A-Z0-9_]*\)=.*/\1/p'); do unset "${name}"; done

  as_postgres initdb -D "${WORK}/data" -U postgres --auth=trust --encoding=UTF8 >/dev/null
  # Set before starting: if start fails half way, cleanup must still stop it.
  STARTED=1
  as_postgres pg_ctl -D "${WORK}/data" -w -s -l "${WORK}/server.log" \
    -o "-c port=5432 -c listen_addresses= -c unix_socket_directories=${WORK} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0 -c shared_buffers=64MB -c max_wal_size=256MB -c maintenance_work_mem=64MB -c max_connections=10" start

  # Point every client below at the private server, never at production.
  export PGHOST="${WORK}" PGPORT=5432 PGUSER=postgres
  if [ -n "${SAVED_SEARCH_PATH}" ]; then export PGOPTIONS="${SAVED_SEARCH_PATH}"; fi
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
  COUNT="$(psql --dbname="${SCRATCH_DB}" --tuples-only --no-align --command "SELECT count(*) FROM \"${table}\";" | tr -d ' ')"
  echo "[restore-verify]   verified ${table}=${COUNT}"
  # Registrations and people are what the system exists to hold; a restore with
  # none of either is a failed rehearsal. REHEARSAL_ALLOW_EMPTY=true is for a
  # fresh development database.
  if { [ "${table}" = "Registration" ] || [ "${table}" = "Person" ]; } \
     && [ "${COUNT}" = "0" ] && [ "${REHEARSAL_ALLOW_EMPTY:-false}" != "true" ]; then
    echo "[restore-verify] ${table} has 0 rows in the restored copy; treating the restore as failed." >&2
    exit 1
  fi
done

echo "[restore-verify] $(date -u +%FT%TZ) restore rehearsal succeeded for ${DUMP}"
